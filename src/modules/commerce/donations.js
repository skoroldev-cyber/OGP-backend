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

const TRANSCRIPT_KIND = 'digital_transcript_access';

const ORDER_DESCRIPTION = 'One Global People contribution';

const GATEWAY_UNAVAILABLE_MESSAGE =
  'Something interrupted the connection. Nothing was charged. Please try again in a moment.';

function last4From(raw) {
  const candidate = String(raw?.cc_number ?? '');
  const match = /([0-9]{4})\s*$/.exec(candidate);
  return match ? match[1] : null;
}

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
    if (error?.code !== 11000 && error?.code !== 11001) throw error;
  }
}

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

  function minimumCents() {
    const configured = config.commerce?.minimumDonationCents;
    return Number.isInteger(configured) && configured > MINIMUM_DONATION_CENTS
      ? configured
      : MINIMUM_DONATION_CENTS;
  }

  async function sendQuietly(template, to, input) {
    try {
      await mail.sendTemplate(template, to, input);
    } catch (error) {
      logger?.error?.({ err: error, template }, 'contribution message could not be sent');
    }
  }

  function toCreatedResponse(donation, digitalAccess) {
    return {
      donationId: donation._id,
      status: 'captured',
      receiptNumber: donation.receiptNumber,
      digitalAccess: digitalAccess ?? null,
    };
  }

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

  async function resume(existing, options) {
    if (existing.status === 'captured') {
      const digitalAccess = await grantsService.describe(existing.digitalAccessGrantId ?? null);
      return toCreatedResponse(existing, digitalAccess);
    }
    if (existing.status === 'declined' || existing.status === 'failed') {
      return { declined: true, reason: existing.failureReason ?? 'card_declined' };
    }

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
