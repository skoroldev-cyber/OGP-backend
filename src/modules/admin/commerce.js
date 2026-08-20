import { COLLECTIONS, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit } from '../../lib/audit.js';
import { nmiClient } from '../../lib/nmiClient.js';
import { toPaging } from '../../lib/schemas.js';
import { ApiError } from '../../plugins/errors.js';
import { recordPaymentTransaction } from '../commerce/donations.js';
import { createGrantsService } from '../commerce/grants.js';
import { toInteger, toIso } from './schemas.js';

export const DEFAULT_DUAL_AUTHORIZATION_CENTS = 25_000;

const AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const COMMERCE_AUDIT_ACTIONS = Object.freeze({
  DONATION_REFUND_AUTHORIZED: 'donation.refund_authorized',
  ORDER_REFUND_AUTHORIZED: 'order.refund_authorized',
});

const UNSETTLED_PATTERN = /not settled|unsettled|only.*void|cannot be refunded/i;

function refundedTotal(refunds) {
  if (!Array.isArray(refunds)) return 0;
  return refunds.reduce(
    (total, entry) => total + (Number.isInteger(entry.amountCents) ? entry.amountCents : 0),
    0,
  );
}

function toRefundLines(refunds) {
  if (!Array.isArray(refunds)) return [];
  return refunds.map((entry) => ({
    amountCents: Number.isInteger(entry.amountCents) ? entry.amountCents : 0,
    reason: entry.reason ?? null,
    at: toIso(entry.at),
    byAdminId: entry.byAdminId ?? null,
  }));
}

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

  function dualAuthorizationCents() {
    const configured = config.commerce?.refundDualAuthorizationCents;
    return Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_DUAL_AUTHORIZATION_CENTS;
  }

  function rangeFilter(query) {
    const range = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    return Object.keys(range).length > 0 ? { createdAt: range } : {};
  }

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

  async function returnFunds({ transactionId, amountCents, full }) {
    let result;
    try {
      result = await gateway.refund({ transactionId, amountCents });
    } catch (error) {
      logger?.error?.({ err: error, transactionId }, 'refund request failed at the gateway');
      throw new ApiError(502, 'REFUND_FAILED', 'The gateway did not complete that refund.');
    }
    if (result.status === 'approved') return { result, kind: 'refund' };

    if (full && UNSETTLED_PATTERN.test(result.responseText ?? '')) {
      const voided = await gateway.voidTransaction({ transactionId });
      if (voided.status === 'approved') return { result: voided, kind: 'void' };
    }

    throw new ApiError(502, 'REFUND_FAILED', 'The gateway did not complete that refund.');
  }

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

    async listDonations(query = {}) {
      const filter = { ...rangeFilter(query) };
      if (query.status) filter.status = query.status;
      if (query.kind) filter.kind = query.kind;
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        donations.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        donations.countDocuments(filter),
      ]);
      return { donations: documents.map(toDonationResponse), total: count };
    },

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

    async listOrders(query = {}) {
      const filter = { ...rangeFilter(query) };
      if (query.status) filter.status = query.status;
      if (query.type) filter.type = query.type;
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        orders.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        orders.countDocuments(filter),
      ]);
      return { orders: documents.map(toOrderResponse), total: count };
    },

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
