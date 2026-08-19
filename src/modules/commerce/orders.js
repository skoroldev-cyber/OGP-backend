/**
 * The product purchase workflow — workflow B (pathway 3).
 *
 * > "Digital transcript access uses a donation workflow. Hardcover editions use a product
 * > purchase workflow. These remain separate throughout the platform."
 *
 * Nothing in this file touches `donations`, the contribution receipt series, or the
 * transcript grant. An order is never a donation with a fulfilment flag, and no request
 * handled here can add a contribution to a purchase (§6.4).
 *
 * ## Reserve, or buy — never both at once
 *
 * Hardcover production is not complete at Phase 1 launch, so the pathway is *Purchase /
 * Reserve*:
 *
 *   - **Reserve** takes an address for a message and a quantity. No payment, no deposit,
 *     no card, no vault entry. Charging for an unproduced book creates a liability the
 *     corpus never authorised, and the confirmation says in plain words that nothing has
 *     been charged.
 *   - **Purchase** is built now and gated behind `HARDCOVER_PURCHASABLE`, and it cannot
 *     activate while `products.priceCents` is null — the gate lives in `products.js` and
 *     this service asks it rather than deciding for itself.
 *
 * ## State machine (§6.7)
 *
 *   reservations  `reserved → notified → converted | canceled`
 *   purchases     `created → paid → fulfillment_hold → shipped → delivered`
 *   any state     `→ canceled | refunded | partially_refunded`
 *
 * ## Copy
 *
 * Every string this module can send a human is written here and linted by the mailer before
 * it leaves the process. None of it contains a deadline, a stock claim, a countdown or an
 * encouragement to hurry: `fulfillment_hold` states the wait honestly, because "limited
 * time" and its relatives are prohibited outright.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { NmiError, nmiClient } from '../../lib/nmiClient.js';
import { signReceiptToken } from '../../lib/tokens.js';
import { ApiError } from '../../plugins/errors.js';
import { recordPaymentTransaction, toNmiResult } from './donations.js';
import { MERCHANT, RECEIPT_SERIES, assignReceiptNumber } from './grants.js';
import { createProductsService } from './products.js';

/** Forward-only lifecycle ranking. A record never moves backwards (§6.7, §9.6). */
export const ORDER_STATE_RANK = Object.freeze({
  created: 1,
  pending: 1,
  reserved: 1,
  notified: 2,
  converted: 3,
  paid: 3,
  fulfillment_hold: 4,
  shipped: 5,
  delivered: 6,
  partially_refunded: 7,
  refunded: 8,
  canceled: 9,
});

const GATEWAY_UNAVAILABLE_MESSAGE =
  'Something interrupted the connection. Nothing was charged. Please try again in a moment.';

const ORDER_DESCRIPTION = 'One Global People printed edition';

/**
 * The reservation confirmation. It states the one fact a reserver most needs — that no
 * money has moved — before anything else, and promises exactly one future message.
 *
 * @param {{ orderNumber: string, quantity: number, title: string }} input Reservation facts.
 * @returns {{ subject: string, text: string }} The message.
 */
export function reservationConfirmation({ orderNumber, quantity, title }) {
  return {
    subject: `Your hardcover reservation — ${MERCHANT.name}`,
    text: [
      'Your hardcover reservation is recorded. You will receive one message when the edition',
      'is ready. Nothing has been charged.',
      '',
      `Reservation number: ${orderNumber}`,
      `Edition: ${title}`,
      `Quantity: ${quantity}`,
      '',
      'You may reply to let us know if you would rather not receive that message, and it',
      'will not be sent.',
      '',
      MERCHANT.name,
      MERCHANT.address,
    ].join('\n'),
  };
}

/**
 * The single notification a reservation may ever produce.
 *
 * @param {{ orderNumber: string, title: string, purchaseUrl: string }} input Facts.
 * @returns {{ subject: string, text: string }} The message.
 */
export function reservationReadyNotice({ orderNumber, title, purchaseUrl }) {
  return {
    subject: `The printed edition is ready — ${MERCHANT.name}`,
    text: [
      `The printed edition of ${title} is now available to order.`,
      '',
      `Your reservation: ${orderNumber}`,
      'Nothing has been charged, and nothing is reserved against your card.',
      '',
      `If you would like a copy: ${purchaseUrl}`,
      '',
      'This is the one message your reservation produces. There will be no others.',
      '',
      MERCHANT.name,
      MERCHANT.address,
    ].join('\n'),
  };
}

/**
 * Split a single-field name for the gateway's AVS fields. Imperfect by nature, which is why
 * the address itself carries the authoritative value and this is only a courtesy split.
 *
 * @param {string|null|undefined} name The address name.
 * @returns {{ firstName: string|undefined, lastName: string|undefined }} Name parts.
 */
function splitName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { firstName: undefined, lastName: undefined };
  }
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, mailer?: object,
 *           nmi?: object, products?: object }} deps Dependencies.
 * @returns {object} The orders service.
 */
export function createOrdersService({
  db,
  config,
  logger = null,
  mailer = null,
  nmi = null,
  products = null,
}) {
  const orders = db.collection(COLLECTIONS.ORDERS);
  const gateway = nmi ?? nmiClient(logger);
  const mail = mailer ?? createMailer({ logger });
  const catalog = products ?? createProductsService({ db, config });

  /**
   * @param {{ subject: string, text: string }} message A rendered message.
   * @param {string} to Recipient address.
   * @returns {Promise<void>} Always resolves.
   */
  async function sendQuietly(message, to) {
    try {
      await mail.send({ to, subject: message.subject, text: message.text });
    } catch (error) {
      logger?.error?.({ err: error }, 'order message could not be sent');
    }
  }

  /**
   * @param {object} product A catalog document.
   * @returns {string} The human title of the edition.
   */
  function titleOf(product) {
    return product.title ?? product.name ?? product.sku;
  }

  /**
   * Present an order that already exists under this idempotency key, rather than taking a
   * second payment (§6.14).
   *
   * @param {object} existing The stored order.
   * @returns {Promise<object|{ declined: true, reason: string }>} The outcome.
   */
  async function resume(existing) {
    if (existing.status === 'paid' || ORDER_STATE_RANK[existing.status] >= ORDER_STATE_RANK.paid) {
      return {
        orderId: existing._id,
        orderNumber: existing.orderNumber,
        status: 'paid',
        receiptNumber: existing.receiptNumber ?? existing.orderNumber,
      };
    }
    if (existing.status === 'canceled') {
      return { declined: true, reason: 'card_declined' };
    }
    throw new ApiError(
      409,
      'PAYMENT_IN_PROGRESS',
      'That order is still being confirmed. Nothing further has been charged; please check again in a moment.',
    );
  }

  return {
    /**
     * `POST /commerce/orders`.
     *
     * @param {object|null} session The authenticated session, or null.
     * @param {object} input The validated request body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<object|{ declined: true, reason: string }>} The outcome.
     */
    async createPurchase(session, input, options = {}) {
      // Both gates — the flag and the price — live in the catalog service, which refuses
      // with the same calm 403 whichever one is closed.
      const product = await catalog.resolveForPurchase(input.productSku);

      const now = new Date();
      const amountCents = catalog.amountFor(product, input.quantity);
      const order = {
        _id: newId(),
        orderNumber: null,
        type: 'purchase',
        mode: 'purchase',
        productSku: product.sku,
        productId: product._id,
        quantity: input.quantity,
        amountCents,
        currency: product.currency ?? 'USD',
        email: input.email.trim().toLowerCase(),
        customer: { name: input.shippingAddress.name ?? null, email: input.email.trim().toLowerCase() },
        shippingAddress: {
          name: input.shippingAddress.name ?? null,
          line1: input.shippingAddress.line1,
          line2: input.shippingAddress.line2 ?? null,
          city: input.shippingAddress.city,
          region: input.shippingAddress.region ?? null,
          postalCode: input.shippingAddress.postalCode ?? null,
          country: input.shippingAddress.country,
        },
        status: 'created',
        nmi: null,
        receiptNumber: null,
        trackingNumber: null,
        idempotencyKey: input.idempotencyKey,
        sessionId: session?._id ?? null,
        refunds: [],
        notifiedAt: null,
        paidAt: null,
        shippedAt: null,
        deliveredAt: null,
        canceledAt: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await orders.insertOne(order);
      } catch (error) {
        if (error?.code === 11000 || error?.code === 11001) {
          const existing = await orders.findOne({ idempotencyKey: input.idempotencyKey });
          if (existing) return resume(existing);
        }
        throw error;
      }

      const orderNumber = await assignReceiptNumber({
        collection: orders,
        series: RECEIPT_SERIES.sale,
        field: 'orderNumber',
        id: order._id,
        now,
      });

      const { firstName, lastName } = splitName(order.shippingAddress.name);
      let result;
      try {
        result = await gateway.sale({
          paymentToken: input.paymentToken,
          amountCents,
          orderId: order._id,
          email: order.email,
          idempotencyKey: order.idempotencyKey,
          currency: order.currency,
          orderDescription: ORDER_DESCRIPTION,
          // AVS is requested on a purchase because an address is present anyway. §6.5.3
          // forbids collecting one on a contribution purely to enable it.
          billingAddress: {
            firstName,
            lastName,
            line1: order.shippingAddress.line1,
            city: order.shippingAddress.city,
            region: order.shippingAddress.region ?? undefined,
            postalCode: order.shippingAddress.postalCode ?? undefined,
            country: order.shippingAddress.country,
          },
        });
      } catch (error) {
        await orders.updateOne(
          { _id: order._id, status: 'created' },
          {
            $set: {
              status: 'canceled',
              canceledAt: new Date(),
              nmi: error instanceof NmiError ? { responseText: error.code } : null,
              ...updateStamps(new Date()),
            },
          },
        );
        throw new ApiError(503, 'PAYMENT_UNAVAILABLE', GATEWAY_UNAVAILABLE_MESSAGE);
      }

      if (result.status !== 'approved') {
        await orders.updateOne(
          { _id: order._id, status: 'created' },
          {
            $set: {
              status: 'canceled',
              canceledAt: new Date(),
              nmi: toNmiResult(result),
              ...updateStamps(new Date()),
            },
          },
        );
        if (result.status === 'declined') return { declined: true, reason: 'card_declined' };
        throw new ApiError(503, 'PAYMENT_UNAVAILABLE', GATEWAY_UNAVAILABLE_MESSAGE);
      }

      const nmiResult = toNmiResult(result);
      const paidAt = new Date();
      await orders.updateOne(
        { _id: order._id },
        {
          $set: {
            status: 'paid',
            paidAt,
            nmi: nmiResult,
            // One S-series number serves as both the order number and the receipt number;
            // §6.12 defines a single sales series, so minting a second would interleave it.
            receiptNumber: orderNumber,
            ...updateStamps(paidAt),
          },
        },
      );

      await recordPaymentTransaction(db, {
        result,
        kind: 'sale',
        workflow: 'purchase',
        refCollection: COLLECTIONS.ORDERS,
        refId: order._id,
        amountCents,
        currency: order.currency,
        idempotencyKey: order.idempotencyKey,
        now: paidAt,
      });

      const receiptUrl = `${config.origins.publicOrigin}/commerce/receipts/${orderNumber}?t=${signReceiptToken({ receiptNumber: orderNumber })}`;
      try {
        await mail.sendTemplate('receipt', order.email, {
          receiptNumber: orderNumber,
          issuedAt: paidAt,
          amountCents,
          currency: order.currency,
          paymentMethod: nmiResult.cardBrand
            ? `${nmiResult.cardBrand}${nmiResult.last4 ? ` ending ${nmiResult.last4}` : ''}`
            : null,
          workflow: 'purchase',
          receiptUrl,
          lineItems: [
            {
              description: titleOf(product),
              quantity: order.quantity,
              amountCents,
            },
          ],
        });
      } catch (error) {
        logger?.error?.({ err: error }, 'order receipt could not be sent');
      }

      await writeAuditSafe(
        db,
        {
          actorType: 'system',
          action: AUDIT_ACTIONS.ORDER_CREATE,
          targetCollection: COLLECTIONS.ORDERS,
          targetId: order._id,
          after: {
            type: 'purchase',
            status: 'paid',
            orderNumber,
            productSku: product.sku,
            quantity: order.quantity,
            amountCents,
          },
          correlationId: options.correlationId ?? null,
        },
        logger,
      );

      return {
        orderId: order._id,
        orderNumber,
        status: 'paid',
        receiptNumber: orderNumber,
      };
    },

    /**
     * `POST /commerce/reservations`. Email and quantity only.
     *
     * @param {object|null} session The authenticated session, or null.
     * @param {object} input The validated request body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ reservationId: string, status: 'reserved' }>} The reservation.
     */
    async createReservation(session, input, options = {}) {
      const product = await catalog.resolveForReservation(input.productSku);

      const now = new Date();
      const reservation = {
        _id: newId(),
        orderNumber: null,
        type: 'reservation',
        mode: 'reserve',
        productSku: product.sku,
        productId: product._id,
        quantity: input.quantity,
        // Null, not zero. A reservation has no amount at all; a zero would read as a price.
        amountCents: null,
        currency: product.currency ?? 'USD',
        email: input.email.trim().toLowerCase(),
        customer: { name: null, email: input.email.trim().toLowerCase() },
        shippingAddress: null,
        status: 'reserved',
        nmi: null,
        receiptNumber: null,
        trackingNumber: null,
        idempotencyKey: null,
        sessionId: session?._id ?? null,
        refunds: [],
        notifiedAt: null,
        paidAt: null,
        shippedAt: null,
        deliveredAt: null,
        canceledAt: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      await orders.insertOne(reservation);
      const orderNumber = await assignReceiptNumber({
        collection: orders,
        series: RECEIPT_SERIES.sale,
        field: 'orderNumber',
        id: reservation._id,
        now,
      });

      await sendQuietly(
        reservationConfirmation({
          orderNumber,
          quantity: reservation.quantity,
          title: titleOf(product),
        }),
        reservation.email,
      );

      await writeAuditSafe(
        db,
        {
          actorType: 'system',
          action: AUDIT_ACTIONS.ORDER_CREATE,
          targetCollection: COLLECTIONS.ORDERS,
          targetId: reservation._id,
          after: {
            type: 'reservation',
            status: 'reserved',
            orderNumber,
            productSku: product.sku,
            quantity: reservation.quantity,
          },
          correlationId: options.correlationId ?? null,
        },
        logger,
      );

      return { reservationId: reservation._id, status: 'reserved' };
    },

    /**
     * Send the one message a reservation produces, and move `reserved → notified`.
     *
     * The guard is the filter, not a branch: only a reservation that is still `reserved`
     * and has never been notified can be selected, so a second call — a retry, a duplicated
     * job, a second administrator — sends nothing. A drip sequence is not merely against
     * policy here; it is unreachable.
     *
     * No route exposes this in Phase 1. Notifying reservations is a founder-run step taken
     * once, when the edition becomes purchasable (§6.7), and the transition exists so that
     * step cannot become a campaign.
     *
     * @param {string} orderId The reservation identifier.
     * @returns {Promise<boolean>} True when this call sent the message.
     */
    async notifyReservation(orderId) {
      const now = new Date();
      const reservation = await orders.findOneAndUpdate(
        { _id: orderId, type: 'reservation', status: 'reserved', notifiedAt: null },
        { $set: { status: 'notified', notifiedAt: now, ...updateStamps(now) } },
        { returnDocument: 'after' },
      );
      if (!reservation) return false;

      const product = await catalog.findBySku(reservation.productSku);
      await sendQuietly(
        reservationReadyNotice({
          orderNumber: reservation.orderNumber,
          title: product ? titleOf(product) : reservation.productSku,
          purchaseUrl: `${config.origins.publicOrigin}/pathways`,
        }),
        reservation.email,
      );
      return true;
    },
  };
}

export default createOrdersService;
