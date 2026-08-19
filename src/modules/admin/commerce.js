/**
 * Commerce administration — two ledgers that never merge.
 *
 * Contributions and printed-edition sales are listed by two routes, over two collections,
 * with two receipt series and two refund policies. There is no combined revenue view and no
 * route in this module returns both: the merchant account is MCC 8398 (charity) while sales
 * are product revenue, and a single "total" tile would be the first step toward
 * misclassifying one as the other (§6.4, §10.4.5).
 *
 * ## Refunds
 *
 * Refunds are an administrator action, never automatic, and above a configured threshold
 * they require **two distinct people**. The second authorisation is not a field on the
 * record — it is read from the append-only audit trail, which is where "who agreed to this"
 * already lives and which nobody can edit to make one person look like two. An
 * authorisation is valid for twenty-four hours and for one exact amount.
 *
 * Access is not punishment. A refunded contribution revokes the transcript grant only when
 * the request explicitly says so — §6.8's "made in error" case. The default for a goodwill
 * reversal is to leave the reader's access exactly where it is.
 */

import { COLLECTIONS, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit } from '../../lib/audit.js';
import { nmiClient } from '../../lib/nmiClient.js';
import { ApiError } from '../../plugins/errors.js';
import { recordPaymentTransaction } from '../commerce/donations.js';
import { createGrantsService } from '../commerce/grants.js';
import { toInteger, toIso } from './schemas.js';

/**
 * Refund value above which a second administrator must agree, in cents. The corpus fixes no
 * figure (§6.10 leaves every amount to the founder), so this is the default until
 * `config.commerce.refundDualAuthorizationCents` is set — changeable without a deployment.
 */
export const DEFAULT_DUAL_AUTHORIZATION_CENTS = 25_000;

/** How long a recorded authorisation stays valid. */
const AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Audit actions this module writes that `lib/audit.js` does not already name. */
export const COMMERCE_AUDIT_ACTIONS = Object.freeze({
  DONATION_REFUND_AUTHORIZED: 'donation.refund_authorized',
  ORDER_REFUND_AUTHORIZED: 'order.refund_authorized',
});

/** Gateway text that means "this has not settled yet; void it instead of refunding". */
const UNSETTLED_PATTERN = /not settled|unsettled|only.*void|cannot be refunded/i;

/**
 * @param {Array<object>|undefined} refunds Stored refund entries.
 * @returns {number} Total already returned, in cents.
 */
function refundedTotal(refunds) {
  if (!Array.isArray(refunds)) return 0;
  return refunds.reduce(
    (total, entry) => total + (Number.isInteger(entry.amountCents) ? entry.amountCents : 0),
    0,
  );
}

/**
 * @param {Array<object>|undefined} refunds Stored refund entries.
 * @returns {Array<object>} The dashboard projection.
 */
function toRefundLines(refunds) {
  if (!Array.isArray(refunds)) return [];
  return refunds.map((entry) => ({
    amountCents: Number.isInteger(entry.amountCents) ? entry.amountCents : 0,
    reason: entry.reason ?? null,
    at: toIso(entry.at),
    byAdminId: entry.byAdminId ?? null,
  }));
}

/**
 * @param {object} document A `donations` document.
 * @returns {object} The dashboard projection.
 */
export function toDonationResponse(document) {
  return {
    id: document._id,
    kind: document.kind,
    amountCents: document.amountCents,
    currency: document.currency ?? 'USD',
    status: document.status,
    anonymous: document.anonymous === true,
    email: document.email ?? null,
    receiptNumber: document.receiptNumber ?? null,
    transactionId: document.nmi?.transactionId ?? null,
    digitalAccessGrantId: document.digitalAccessGrantId ?? null,
    refunds: toRefundLines(document.refunds),
    capturedAt: toIso(document.capturedAt),
    refundedAt: toIso(document.refundedAt),
    createdAt: toIso(document.createdAt),
  };
}

/**
 * @param {object} document An `orders` document.
 * @returns {object} The dashboard projection.
 */
export function toOrderResponse(document) {
  return {
    id: document._id,
    orderNumber: document.orderNumber ?? null,
    type: document.type,
    productSku: document.productSku ?? null,
    quantity: toInteger(document.quantity),
    amountCents: toInteger(document.amountCents),
    currency: document.currency ?? null,
    status: document.status,
    email: document.email ?? null,
    trackingNumber: document.trackingNumber ?? null,
    receiptNumber: document.receiptNumber ?? null,
    transactionId: document.nmi?.transactionId ?? null,
    refunds: toRefundLines(document.refunds),
    notifiedAt: toIso(document.notifiedAt),
    paidAt: toIso(document.paidAt),
    shippedAt: toIso(document.shippedAt),
    createdAt: toIso(document.createdAt),
  };
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, nmi?: object,
 *           grants?: object }} deps Dependencies.
 * @returns {object} The admin commerce service.
 */
export function createAdminCommerceService({
  db,
  config,
  logger = null,
  nmi = null,
  grants = null,
}) {
  const donations = db.collection(COLLECTIONS.DONATIONS);
  const orders = db.collection(COLLECTIONS.ORDERS);
  const auditLog = db.collection(COLLECTIONS.AUDIT_LOG);
  const gateway = nmi ?? nmiClient(logger);
  const grantsService = grants ?? createGrantsService({ db, config, logger });

  /** The threshold above which two people are required. */
  function dualAuthorizationCents() {
    const configured = config.commerce?.refundDualAuthorizationCents;
    return Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_DUAL_AUTHORIZATION_CENTS;
  }

  /**
   * Build a date-range filter for a listing.
   *
   * @param {object} query The validated query string.
   * @returns {object} A Mongo filter fragment.
   */
  function rangeFilter(query) {
    const range = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    return Object.keys(range).length > 0 ? { createdAt: range } : {};
  }

  /**
   * Has a *different* administrator already authorised this exact refund?
   *
   * @param {{ action: string, targetId: string, amountCents: number, adminId: string }} input
   *        Authorisation facts.
   * @returns {Promise<object|null>} The prior authorisation, or null.
   */
  async function findPriorAuthorization({ action, targetId, amountCents, adminId }) {
    const since = new Date(Date.now() - AUTHORIZATION_WINDOW_MS);
    const [entry] = await auditLog
      .find(
        {
          action,
          targetId,
          actorType: 'admin',
          actorId: { $ne: adminId },
          at: { $gte: since },
          'after.amountCents': amountCents,
        },
        { projection: { actorId: 1, at: 1 }, sort: { at: -1 }, limit: 1 },
      )
      .toArray();
    return entry ?? null;
  }

  /**
   * Return money through the gateway, falling back to a void when the sale has not settled.
   *
   * @param {{ transactionId: string, amountCents: number, full: boolean }} input Refund facts.
   * @returns {Promise<{ result: object, kind: 'refund'|'void' }>} What the gateway did.
   * @throws {ApiError} 502 when neither path succeeds.
   */
  async function returnFunds({ transactionId, amountCents, full }) {
    let result;
    try {
      result = await gateway.refund({ transactionId, amountCents });
    } catch (error) {
      logger?.error?.({ err: error, transactionId }, 'refund request failed at the gateway');
      throw new ApiError(502, 'REFUND_FAILED', 'The gateway did not complete that refund.');
    }
    if (result.status === 'approved') return { result, kind: 'refund' };

    // An unsettled sale is voided rather than refunded (§6.8). Only a full reversal can be
    // a void, so a partial request never silently becomes one.
    if (full && UNSETTLED_PATTERN.test(result.responseText ?? '')) {
      const voided = await gateway.voidTransaction({ transactionId });
      if (voided.status === 'approved') return { result: voided, kind: 'void' };
    }

    throw new ApiError(502, 'REFUND_FAILED', 'The gateway did not complete that refund.');
  }

  /**
   * The shared refund path. The two workflows call it with their own collection, their own
   * audit action and their own after-effects; nothing about the money is shared between
   * them beyond this function's mechanics.
   *
   * @param {object} input Refund input.
   * @returns {Promise<{ refund: object }>} The outcome.
   */
  async function refund({
    admin,
    record,
    collection,
    collectionName,
    workflow,
    authorizeAction,
    auditAction,
    body,
    options,
  }) {
    const captured = Number.isInteger(record.amountCents) ? record.amountCents : 0;
    const already = refundedTotal(record.refunds);
    const remaining = captured - already;
    if (remaining <= 0) {
      throw new ApiError(409, 'ALREADY_REFUNDED', 'That record has already been returned in full.');
    }

    const amountCents = toInteger(body.amountCents, remaining) ?? remaining;
    if (amountCents <= 0 || amountCents > remaining) {
      throw new ApiError(
        422,
        'AMOUNT_OUT_OF_RANGE',
        'That amount is larger than what remains on this record.',
      );
    }

    const threshold = dualAuthorizationCents();
    const authorizationsRequired = amountCents > threshold ? 2 : 1;

    if (authorizationsRequired === 2) {
      const prior = await findPriorAuthorization({
        action: authorizeAction,
        targetId: record._id,
        amountCents,
        adminId: admin._id,
      });
      if (!prior) {
        await writeAudit(db, {
          actorType: 'admin',
          actorId: admin._id,
          action: authorizeAction,
          targetCollection: collectionName,
          targetId: record._id,
          after: { amountCents, reason: body.reason },
          correlationId: options?.correlationId ?? null,
        });
        return {
          refund: {
            status: 'authorization_recorded',
            amountCents,
            transactionId: null,
            authorizationsHeld: 1,
            authorizationsRequired,
            accessRevoked: false,
          },
        };
      }
    }

    const transactionId = record.nmi?.transactionId;
    if (typeof transactionId !== 'string' || transactionId === '') {
      throw new ApiError(
        409,
        'NO_TRANSACTION',
        'That record has no settled gateway transaction to return.',
      );
    }

    const full = amountCents === remaining && already === 0;
    const { result, kind } = await returnFunds({ transactionId, amountCents, full });

    const now = new Date();
    const total = already + amountCents;
    const status = total >= captured ? 'refunded' : 'partially_refunded';

    await collection.updateOne(
      { _id: record._id },
      {
        $push: {
          refunds: {
            nmiTransactionId: result.transactionId ?? transactionId,
            amountCents,
            reason: body.reason,
            at: now,
            byAdminId: admin._id,
          },
        },
        $set: {
          status,
          ...(status === 'refunded' ? { refundedAt: now } : {}),
          ...updateStamps(now),
        },
      },
    );

    await recordPaymentTransaction(db, {
      result,
      kind: kind === 'void' ? 'void' : 'refund',
      workflow,
      refCollection: collectionName,
      refId: record._id,
      amountCents,
      currency: record.currency ?? 'USD',
      now,
    });

    let accessRevoked = false;
    if (workflow === 'donation' && body.revokeAccess === true) {
      accessRevoked = (await grantsService.revokeForDonation(record._id, { now })) > 0;
    }

    await writeAudit(db, {
      actorType: 'admin',
      actorId: admin._id,
      action: auditAction,
      targetCollection: collectionName,
      targetId: record._id,
      before: { status: record.status, refundedCents: already },
      after: {
        status,
        amountCents,
        reason: body.reason,
        gatewayKind: kind,
        accessRevoked,
        authorizationsRequired,
      },
      correlationId: options?.correlationId ?? null,
    });

    return {
      refund: {
        status: kind === 'void' ? 'voided' : status,
        amountCents,
        transactionId: result.transactionId ?? transactionId,
        authorizationsHeld: authorizationsRequired,
        authorizationsRequired,
        accessRevoked,
      },
    };
  }

  return {
    /* ----------------------- workflow A — contributions ---------------------- */

    /**
     * @param {object} query The validated query string.
     * @returns {Promise<{ donations: object[], total: number }>} The contribution ledger.
     */
    async listDonations(query = {}) {
      const filter = { ...rangeFilter(query) };
      if (query.status) filter.status = query.status;
      if (query.kind) filter.kind = query.kind;
      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        donations.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        donations.countDocuments(filter),
      ]);
      return { donations: documents.map(toDonationResponse), total: count };
    },

    /**
     * `POST /admin/donations/:id/refund`.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The contribution identifier.
     * @param {object} body The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ refund: object }>} The outcome.
     */
    async refundDonation(admin, id, body, options = {}) {
      const record = await donations.findOne({ _id: id });
      if (!record) throw new ApiError(404, 'NOT_FOUND', 'That contribution does not exist.');
      if (record.status !== 'captured' && record.status !== 'partially_refunded') {
        throw new ApiError(
          409,
          'NOT_REFUNDABLE',
          'Only a captured contribution can be returned.',
        );
      }
      return refund({
        admin,
        record,
        collection: donations,
        collectionName: COLLECTIONS.DONATIONS,
        workflow: 'donation',
        authorizeAction: COMMERCE_AUDIT_ACTIONS.DONATION_REFUND_AUTHORIZED,
        auditAction: AUDIT_ACTIONS.DONATION_REFUND,
        body,
        options,
      });
    },

    /* ------------------------- workflow B — editions ------------------------- */

    /**
     * @param {object} query The validated query string.
     * @returns {Promise<{ orders: object[], total: number }>} The sales ledger.
     */
    async listOrders(query = {}) {
      const filter = { ...rangeFilter(query) };
      if (query.status) filter.status = query.status;
      if (query.type) filter.type = query.type;
      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        orders.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        orders.countDocuments(filter),
      ]);
      return { orders: documents.map(toOrderResponse), total: count };
    },

    /**
     * `POST /admin/orders/:id/refund`.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The order identifier.
     * @param {object} body The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ refund: object }>} The outcome.
     */
    async refundOrder(admin, id, body, options = {}) {
      const record = await orders.findOne({ _id: id });
      if (!record) throw new ApiError(404, 'NOT_FOUND', 'That order does not exist.');
      if (record.type !== 'purchase') {
        throw new ApiError(
          409,
          'NOT_REFUNDABLE',
          'A reservation takes no payment, so there is nothing to return.',
        );
      }
      if (!['paid', 'fulfillment_hold', 'shipped', 'delivered', 'partially_refunded'].includes(record.status)) {
        throw new ApiError(409, 'NOT_REFUNDABLE', 'Only a paid order can be returned.');
      }
      return refund({
        admin,
        record,
        collection: orders,
        collectionName: COLLECTIONS.ORDERS,
        workflow: 'purchase',
        authorizeAction: COMMERCE_AUDIT_ACTIONS.ORDER_REFUND_AUTHORIZED,
        auditAction: AUDIT_ACTIONS.ORDER_REFUND,
        body,
        options,
      });
    },

    /**
     * `POST /admin/orders/:id/fulfill`. Records a tracking number and ships the order.
     * Fulfilment integration is out of Phase 1 scope beyond exactly this (§6.7).
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The order identifier.
     * @param {{ trackingNumber: string, carrier?: string }} body The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ order: object }>} The updated order.
     */
    async fulfillOrder(admin, id, body, options = {}) {
      const record = await orders.findOne({ _id: id });
      if (!record) throw new ApiError(404, 'NOT_FOUND', 'That order does not exist.');
      if (!['paid', 'fulfillment_hold'].includes(record.status)) {
        throw new ApiError(
          409,
          'NOT_FULFILLABLE',
          'Only a paid order awaiting despatch can be fulfilled.',
        );
      }

      const now = new Date();
      const updated = await orders.findOneAndUpdate(
        { _id: id, status: record.status },
        {
          $set: {
            status: 'shipped',
            trackingNumber: body.trackingNumber,
            shippedAt: now,
            ...updateStamps(now),
          },
        },
        { returnDocument: 'after' },
      );
      if (!updated) {
        throw new ApiError(409, 'INVALID_TRANSITION', 'That order changed while it was being read.');
      }

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.ORDER_FULFILL,
        targetCollection: COLLECTIONS.ORDERS,
        targetId: id,
        before: { status: record.status },
        after: { status: 'shipped', carrier: body.carrier ?? null },
        correlationId: options.correlationId ?? null,
      });

      return { order: toOrderResponse(updated) };
    },
  };
}

export default createAdminCommerceService;
