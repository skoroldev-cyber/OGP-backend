/**
 * The contribution workflow — workflow A (pathways 2 and 5).
 *
 * > "Digital transcript access uses a donation workflow. Hardcover editions use a product
 * > purchase workflow. These remain separate throughout the platform."
 *
 * Nothing in this file touches `orders`, `products`, shipping, or the sales receipt series.
 * There is no cart, no cross-sell, and no "add a donation to your order" — merging the two
 * would also commingle MCC 8398 charitable revenue with product revenue (§6.4, §6.13).
 *
 * ## What the reader experiences
 *
 * Pay-what-you-can, donor-chosen, one time only. No preset is highlighted, no goal meter,
 * no supporter count, no monthly toggle, no "give again". The acknowledgment is a receipt
 * and a thank-you; §6.6 forbids every form of gamification on this path, and a one-dollar
 * contribution is acknowledged exactly as a thousand-dollar one is.
 *
 * ## Double charging is structurally impossible from the UI
 *
 * Every attempt carries an application-level `idempotencyKey`, unique-indexed on
 * `donations`. A repeated key is treated as a *status query*, never as a second attempt
 * (§6.14). The key is additionally handed to NMI as a merchant-defined field so the
 * gateway's own duplicate detection sees it too. When a record is stuck at `initiated` —
 * the response was lost in flight — the gateway is queried by order id before any retry is
 * accepted, so an ambiguous outcome is resolved by asking the gateway rather than by
 * charging again.
 *
 * ## Card data
 *
 * Never reaches this process. The browser tokenises with Collect.js; this service forwards
 * a single-use token and stores only brand and last four digits (§6.13.1). The security key
 * lives in configuration, is read only by `lib/nmiClient.js`, and appears in no log line.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { NmiError, nmiClient } from '../../lib/nmiClient.js';
import { signReceiptToken } from '../../lib/tokens.js';
import { ApiError } from '../../plugins/errors.js';
import { RECEIPT_SERIES, assignReceiptNumber, createGrantsService } from './grants.js';
import { MINIMUM_DONATION_CENTS } from './schemas.js';

/** The contribution kind that carries a transcript grant. */
const TRANSCRIPT_KIND = 'digital_transcript_access';

/** What the gateway is told this charge is for. Linted copy, no solicitation language. */
const ORDER_DESCRIPTION = 'One Global People contribution';

/** Calm, honest, non-coercive — §6.14, verbatim in intent. */
const GATEWAY_UNAVAILABLE_MESSAGE =
  'Something interrupted the connection. Nothing was charged. Please try again in a moment.';

/**
 * Extract the last four digits of a masked card number. The gateway returns a masked value;
 * this reads only the trailing four characters when they are digits, so no PAN can ever
 * enter the database even if the gateway's masking changes.
 *
 * @param {Record<string, string>|undefined} raw The raw gateway fields.
 * @returns {string|null} Four digits, or null.
 */
function last4From(raw) {
  const candidate = String(raw?.cc_number ?? '');
  const match = /([0-9]{4})\s*$/.exec(candidate);
  return match ? match[1] : null;
}

/**
 * The stored gateway result. Brand and last four digits only — never a PAN, an expiry or a
 * CVV, in the database, in a log, or in an error report.
 *
 * @param {object} result A normalised NMI response.
 * @returns {object} The `nmi` sub-document.
 */
export function toNmiResult(result) {
  return {
    transactionId: result.transactionId ?? null,
    authCode: result.authCode ?? null,
    responseCode: result.responseCode ?? null,
    responseText: result.responseText ?? null,
    avsResult: result.avsResponse ?? null,
    cvvResult: result.cvvResponse ?? null,
    cardBrand: result.raw?.cc_type ?? null,
    last4: last4From(result.raw),
    customerVaultId: null,
  };
}

/**
 * Write one row of the gateway audit trail. Both workflows write here; the `workflow` and
 * `refCollection` fields are what keep the two ledgers separable at export time (§6.12).
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {object} input Transaction facts.
 * @returns {Promise<void>} Resolves when written, or when the row already existed.
 */
export async function recordPaymentTransaction(db, input) {
  const {
    result,
    kind,
    workflow,
    refCollection,
    refId,
    amountCents,
    currency = 'USD',
    idempotencyKey = null,
    now = new Date(),
  } = input;
  if (!result?.transactionId) return;

  const nmi = toNmiResult(result);
  try {
    await db.collection(COLLECTIONS.PAYMENT_TRANSACTIONS).insertOne({
      _id: newId(),
      gateway: 'nmi',
      gatewayTransactionId: result.transactionId,
      kind,
      workflow,
      refCollection,
      refId,
      amountCents,
      currency,
      responseCode: nmi.responseCode,
      responseText: nmi.responseText,
      avsResult: nmi.avsResult,
      cvvResult: nmi.cvvResult,
      cardBrand: nmi.cardBrand,
      last4: nmi.last4,
      idempotencyKey,
      ...creationStamps(SCHEMA_VERSION, now),
    });
  } catch (error) {
    // The trail is append-only and unique per (transaction, kind). A duplicate means the
    // row is already there — which is the desired end state, not a failure.
    if (error?.code !== 11000 && error?.code !== 11001) throw error;
  }
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, mailer?: object,
 *           nmi?: object, grants?: object }} deps Dependencies.
 * @returns {object} The donations service.
 */
export function createDonationsService({
  db,
  config,
  logger = null,
  mailer = null,
  nmi = null,
  grants = null,
}) {
  const donations = db.collection(COLLECTIONS.DONATIONS);
  const gateway = nmi ?? nmiClient(logger);
  const mail = mailer ?? createMailer({ logger });
  const grantsService = grants ?? createGrantsService({ db, config, logger });

  /** The configured floor, never below the §6.6 minimum. */
  function minimumCents() {
    const configured = config.commerce?.minimumDonationCents;
    return Number.isInteger(configured) && configured > MINIMUM_DONATION_CENTS
      ? configured
      : MINIMUM_DONATION_CENTS;
  }

  /**
   * Send one message without letting a mail failure undo a completed contribution. The
   * money moved; a transport problem is ours to fix, not the reader's to absorb.
   *
   * @param {string} template Template name.
   * @param {string} to Recipient address.
   * @param {object} input Template input.
   * @returns {Promise<void>} Always resolves.
   */
  async function sendQuietly(template, to, input) {
    try {
      await mail.sendTemplate(template, to, input);
    } catch (error) {
      logger?.error?.({ err: error, template }, 'contribution message could not be sent');
    }
  }

  /**
   * The success payload, assembled once so a fresh capture and a replayed idempotency key
   * cannot drift apart.
   *
   * @param {object} donation The stored contribution.
   * @param {{ granted: boolean, url: string }|null} digitalAccess The grant, if any.
   * @returns {object} The route response.
   */
  function toCreatedResponse(donation, digitalAccess) {
    return {
      donationId: donation._id,
      status: 'captured',
      receiptNumber: donation.receiptNumber,
      digitalAccess: digitalAccess ?? null,
    };
  }

  /**
   * Everything that happens once the gateway approves: the receipt number, the ledger row,
   * the grant, the two emails and the audit entry.
   *
   * @param {object} donation The `initiated` contribution.
   * @param {object} result The approved gateway response.
   * @param {{ correlationId?: string|null }} options Audit context.
   * @returns {Promise<object>} The route response.
   */
  async function capture(donation, result, options = {}) {
    const now = new Date();
    const nmiResult = toNmiResult(result);

    const receiptNumber = await assignReceiptNumber({
      collection: donations,
      series: RECEIPT_SERIES.contribution,
      field: 'receiptNumber',
      id: donation._id,
      now,
      extraSet: {
        status: 'captured',
        capturedAt: now,
        nmi: nmiResult,
        failureReason: null,
      },
    });

    await recordPaymentTransaction(db, {
      result,
      kind: 'sale',
      workflow: 'donation',
      refCollection: COLLECTIONS.DONATIONS,
      refId: donation._id,
      amountCents: donation.amountCents,
      currency: donation.currency,
      idempotencyKey: donation.idempotencyKey,
      now,
    });

    let digitalAccess = null;
    if (donation.kind === TRANSCRIPT_KIND) {
      // Digital delivery is automated. There is no manual fulfilment step on this path.
      const grant = await grantsService.mint({
        donationId: donation._id,
        email: donation.email ?? null,
        grantType: 'contribution',
        now,
      });
      await donations.updateOne(
        { _id: donation._id },
        { $set: { digitalAccessGrantId: grant.grantId, ...updateStamps(now) } },
      );
      digitalAccess = { granted: true, url: grant.url };
    }

    const captured = {
      ...donation,
      status: 'captured',
      capturedAt: now,
      nmi: nmiResult,
      receiptNumber,
    };

    if (typeof donation.email === 'string' && donation.email !== '') {
      const receiptUrl = `${config.origins.publicOrigin}/commerce/receipts/${receiptNumber}?t=${signReceiptToken({ receiptNumber })}`;
      await sendQuietly('receipt', donation.email, {
        receiptNumber,
        issuedAt: now,
        amountCents: donation.amountCents,
        currency: donation.currency,
        paymentMethod: nmiResult.cardBrand
          ? `${nmiResult.cardBrand}${nmiResult.last4 ? ` ending ${nmiResult.last4}` : ''}`
          : null,
        workflow: 'donation',
        providedInReturn:
          donation.kind === TRANSCRIPT_KIND ? 'digital transcript access' : null,
        receiptUrl,
      });
      if (digitalAccess) {
        await sendQuietly('transcript_delivery', donation.email, {
          accessUrl: digitalAccess.url,
          receiptNumber,
        });
      }
    }

    await writeAuditSafe(
      db,
      {
        actorType: 'system',
        action: AUDIT_ACTIONS.DONATION_CAPTURE,
        targetCollection: COLLECTIONS.DONATIONS,
        targetId: donation._id,
        after: {
          status: 'captured',
          kind: donation.kind,
          amountCents: donation.amountCents,
          receiptNumber,
          digitalAccessGranted: digitalAccess !== null,
        },
        correlationId: options.correlationId ?? null,
      },
      logger,
    );

    return toCreatedResponse(captured, digitalAccess);
  }

  /**
   * Record a refusal. No payment_transactions row is written: a decline has no gateway
   * transaction id, and the ledger holds movements of money, not attempts.
   *
   * @param {object} donation The `initiated` contribution.
   * @param {object} result The gateway response.
   * @param {'declined'|'failed'} status The terminal status.
   * @param {string} reason A coarse machine reason.
   * @returns {Promise<void>} Resolves when recorded.
   */
  async function recordRefusal(donation, result, status, reason) {
    const now = new Date();
    await donations.updateOne(
      { _id: donation._id, status: 'initiated' },
      {
        $set: {
          status,
          failureReason: reason,
          nmi: toNmiResult(result),
          ...updateStamps(now),
        },
      },
    );
  }

  /**
   * Re-present the outcome of a contribution that already exists under this idempotency
   * key. §6.14: "the server treats a repeated key as a status query — double-charging is
   * structurally impossible from the UI."
   *
   * @param {object} existing The stored contribution.
   * @param {{ correlationId?: string|null }} options Audit context.
   * @returns {Promise<object>} A created response, or a decline.
   */
  async function resume(existing, options) {
    if (existing.status === 'captured') {
      const digitalAccess = await grantsService.describe(existing.digitalAccessGrantId ?? null);
      return toCreatedResponse(existing, digitalAccess);
    }
    if (existing.status === 'declined' || existing.status === 'failed') {
      return { declined: true, reason: existing.failureReason ?? 'card_declined' };
    }

    // Ambiguous: we hold an `initiated` record with no gateway answer. Ask the gateway what
    // happened before letting anything else touch this key (§6.14).
    let queried = null;
    try {
      queried = await gateway.request({ type: 'query', order_id: existing._id });
    } catch (error) {
      logger?.warn?.(
        { err: error, donationId: existing._id },
        'gateway query for an ambiguous contribution did not answer',
      );
    }
    if (queried?.ok && queried.transactionId) {
      return capture(existing, queried, options);
    }
    if (queried && queried.status === 'declined') {
      await recordRefusal(existing, queried, 'declined', 'card_declined');
      return { declined: true, reason: 'card_declined' };
    }
    throw new ApiError(
      409,
      'PAYMENT_IN_PROGRESS',
      'That payment is still being confirmed. Nothing further has been charged; please check again in a moment.',
    );
  }

  return {
    grants: grantsService,

    /**
     * `POST /commerce/donations`.
     *
     * @param {object|null} session The authenticated session, or null.
     * @param {object} input The validated request body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<object|{ declined: true, reason: string }>} The outcome.
     */
    async create(session, input, options = {}) {
      const floor = minimumCents();
      if (input.amountCents < floor) {
        throw new ApiError(
          422,
          'AMOUNT_BELOW_MINIMUM',
          `The smallest amount this can process is ${(floor / 100).toFixed(2)} USD.`,
        );
      }

      const now = new Date();
      const anonymous = input.anonymous === true;
      const donation = {
        _id: newId(),
        kind: input.kind,
        amountCents: input.amountCents,
        currency: input.currency ?? 'USD',
        status: 'initiated',
        anonymous,
        email: typeof input.email === 'string' ? input.email.trim().toLowerCase() : null,
        displayName: null,
        // An anonymous contribution keeps no link to the reading session at all. The
        // linkage is optional funnel data (§9.2.9); anonymity is the reader's request, and
        // the protective reading of it is to store less, not to store it and hide it.
        sessionId: anonymous ? null : (session?._id ?? null),
        nmi: null,
        receiptNumber: null,
        digitalAccessGrantId: null,
        idempotencyKey: input.idempotencyKey,
        refunds: [],
        failureReason: null,
        capturedAt: null,
        refundedAt: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await donations.insertOne(donation);
      } catch (error) {
        if (error?.code === 11000 || error?.code === 11001) {
          const existing = await donations.findOne({ idempotencyKey: input.idempotencyKey });
          if (existing) return resume(existing, options);
        }
        throw error;
      }

      let result;
      try {
        result = await gateway.sale({
          paymentToken: input.paymentToken,
          amountCents: donation.amountCents,
          orderId: donation._id,
          email: donation.email ?? undefined,
          idempotencyKey: donation.idempotencyKey,
          currency: donation.currency,
          orderDescription: ORDER_DESCRIPTION,
        });
      } catch (error) {
        await donations.updateOne(
          { _id: donation._id, status: 'initiated' },
          {
            $set: {
              status: 'failed',
              failureReason: error instanceof NmiError ? error.code : 'gateway_error',
              ...updateStamps(new Date()),
            },
          },
        );
        throw new ApiError(503, 'PAYMENT_UNAVAILABLE', GATEWAY_UNAVAILABLE_MESSAGE);
      }

      if (result.status === 'approved') return capture(donation, result, options);

      if (result.status === 'declined') {
        await recordRefusal(donation, result, 'declined', 'card_declined');
        return { declined: true, reason: 'card_declined' };
      }

      await recordRefusal(donation, result, 'failed', 'gateway_error');
      throw new ApiError(503, 'PAYMENT_UNAVAILABLE', GATEWAY_UNAVAILABLE_MESSAGE);
    },

    /**
     * `POST /commerce/donations/free-access`.
     *
     * The corpus requires the capability; whether it is on at launch is a founder switch
     * (§6.6). The path has no gateway dependency at all, which is deliberate: a payments
     * outage must never lock a reader out of the transcript.
     *
     * No shame framing exists here — no "are you sure", no comparison to contributors, no
     * second ask. One address, one grant, one delivery.
     *
     * @param {object} input The validated request body.
     * @returns {Promise<{ digitalAccess: { granted: true, url: string } }>} The grant.
     */
    async freeAccess(input) {
      if (config.flags.freeAccessEnabled !== true) {
        throw new ApiError(
          403,
          'FREE_ACCESS_UNAVAILABLE',
          'This path is not open at the moment.',
        );
      }

      const address = input.email.trim().toLowerCase();
      const grant = await grantsService.mint({
        donationId: null,
        email: address,
        grantType: 'free_access',
      });

      await sendQuietly('transcript_delivery', address, {
        accessUrl: grant.url,
        receiptNumber: null,
      });

      return { digitalAccess: { granted: true, url: grant.url } };
    },
  };
}

export default createDonationsService;
