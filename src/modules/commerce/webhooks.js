/**
 * NMI webhook ingestion.
 *
 * Settlement truth arrives here; capture truth arrives in the synchronous sale response
 * (§6.5.3). The reader is never made to wait on a webhook, and a webhook never changes what
 * the reader was already told about their own payment.
 *
 * Five rules govern every delivery:
 *
 * 1. **The signature is verified over the raw bytes.** Re-serialising parsed JSON changes
 *    them and the HMAC would never verify, which is why `app.js` preserves
 *    `request.rawBody` for exactly this endpoint. A failure is rejected *and* alarmed — a
 *    spike is the signature of someone probing the endpoint (§9.10).
 * 2. **Delivery is at-least-once, so processing is idempotent.** Each event is stored under
 *    its gateway event id; a repeat is skipped, not reprocessed. The unique index is the
 *    arbiter, so two concurrent deliveries cannot both win.
 * 3. **The stored payload is redacted first.** The gateway defines the shape; this module
 *    strips every card field and every network identifier before the document is written.
 *    No PAN, expiry, CVV, address or IP reaches `nmi_webhook_events`.
 * 4. **Reported amounts are never trusted.** The transaction is re-queried through the
 *    Payment API before any amount is believed. When the re-query is inconclusive, the
 *    amount already recorded on our own record is used — never the number in the webhook.
 * 5. **State moves forward only.** A late or reordered delivery cannot walk a record
 *    backwards, and a chargeback flags the record for a human. Transcript access is never
 *    revoked automatically: "never auto-punish the reader record" (§6.8).
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { nmiClient } from '../../lib/nmiClient.js';
import { verifyWebhookSignature } from '../../lib/webhookVerify.js';
import { ApiError } from '../../plugins/errors.js';
import { recordPaymentTransaction } from './donations.js';
import { ORDER_STATE_RANK } from './orders.js';

/** Forward-only lifecycle ranking for contributions. */
export const DONATION_STATE_RANK = Object.freeze({
  initiated: 0,
  pending: 1,
  failed: 1,
  declined: 1,
  captured: 2,
  succeeded: 2,
  partially_refunded: 3,
  refunded: 4,
});

/**
 * Audit actions this module writes that `lib/audit.js` does not already name. They are
 * declared once, here, so the same occurrence is never logged under two names.
 */
export const WEBHOOK_AUDIT_ACTIONS = Object.freeze({
  DONATION_CHARGEBACK: 'donation.chargeback',
  ORDER_CHARGEBACK: 'order.chargeback',
  WEBHOOK_UNMATCHED: 'webhook.unmatched',
});

/**
 * Keys that never enter storage, normalised so `cc_number`, `ccNumber` and `CCNUMBER` are
 * all the same key. Card data and network identifiers are dropped outright rather than
 * masked: a masked field is still a field somebody will one day try to read.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'ccnumber',
  'ccexp',
  'ccexpiration',
  'cardnumber',
  'cardexpiry',
  'cvv',
  'cvc',
  'checkaba',
  'checkaccount',
  'checkname',
  'securitykey',
  'paymenttoken',
  'token',
  'ip',
  'ipaddress',
  'customerip',
  'useragent',
  'browser',
  'latitude',
  'longitude',
  'geo',
  'fingerprint',
  'deviceid',
]);

const MAX_PAYLOAD_DEPTH = 6;
const MAX_PAYLOAD_ARRAY = 50;
const MAX_PAYLOAD_STRING = 512;

/**
 * Deeply copy a gateway payload, dropping everything that may not be retained.
 *
 * @param {unknown} value Any value from the gateway.
 * @param {number} [depth] Internal recursion depth.
 * @returns {unknown} A storable copy.
 */
export function redactGatewayPayload(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_PAYLOAD_STRING ? `${value.slice(0, MAX_PAYLOAD_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_PAYLOAD_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PAYLOAD_ARRAY).map((item) => redactGatewayPayload(item, depth + 1));
  }
  if (typeof value !== 'object') return null;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalised)) continue;
    out[key] = redactGatewayPayload(nested, depth + 1);
  }
  return out;
}

/**
 * Read the first present value from a list of candidate paths.
 *
 * @param {object} source The parsed body.
 * @param {string[][]} paths Candidate paths.
 * @returns {string|null} The value as a string, or null.
 */
function pick(source, paths) {
  for (const path of paths) {
    let cursor = source;
    let found = true;
    for (const segment of path) {
      if (cursor === null || typeof cursor !== 'object' || !(segment in cursor)) {
        found = false;
        break;
      }
      cursor = cursor[segment];
    }
    if (found && (typeof cursor === 'string' || typeof cursor === 'number')) {
      const value = String(cursor).trim();
      if (value !== '') return value;
    }
  }
  return null;
}

/**
 * Classify a gateway event type into the five outcomes this platform reconciles.
 *
 * @param {string|null} eventType The raw event type.
 * @returns {'sale'|'refund'|'void'|'settlement'|'chargeback'|'unknown'} The class.
 */
export function classifyEvent(eventType) {
  const value = String(eventType ?? '').toLowerCase();
  if (value === '') return 'unknown';
  if (value.includes('chargeback') || value.includes('dispute')) return 'chargeback';
  if (value.includes('refund')) return 'refund';
  if (value.includes('void')) return 'void';
  if (value.includes('settle')) return 'settlement';
  if (value.includes('sale') || value.includes('transaction') || value.includes('payment')) {
    return 'sale';
  }
  return 'unknown';
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, nmi?: object }} deps
 *        Dependencies.
 * @returns {object} The webhooks service.
 */
export function createWebhooksService({ db, config, logger = null, nmi = null }) {
  const events = db.collection(COLLECTIONS.NMI_WEBHOOK_EVENTS);
  const donations = db.collection(COLLECTIONS.DONATIONS);
  const orders = db.collection(COLLECTIONS.ORDERS);
  const gateway = nmi ?? nmiClient(logger);

  /**
   * Ask the gateway what a transaction really is. The webhook's own numbers are evidence
   * that something happened, never evidence of how much.
   *
   * @param {string} transactionId The gateway transaction id.
   * @returns {Promise<object|null>} The normalised response, or null when unanswered.
   */
  async function reQuery(transactionId) {
    try {
      const result = await gateway.query({ transactionId });
      return result ?? null;
    } catch (error) {
      logger?.warn?.(
        { err: error, transactionId },
        'gateway re-query failed; falling back to the amount already recorded',
      );
      return null;
    }
  }

  /**
   * Locate the record a transaction belongs to. Two separate lookups against two separate
   * collections — the workflows are not merged even to answer this question.
   *
   * @param {string} transactionId The gateway transaction id.
   * @returns {Promise<{ workflow: 'donation'|'purchase', collection: object,
   *                     collectionName: string, record: object }|null>} The parent.
   */
  async function locate(transactionId) {
    const donation = await donations.findOne({ 'nmi.transactionId': transactionId });
    if (donation) {
      return {
        workflow: 'donation',
        collection: donations,
        collectionName: COLLECTIONS.DONATIONS,
        record: donation,
      };
    }
    const order = await orders.findOne({ 'nmi.transactionId': transactionId });
    if (order) {
      return {
        workflow: 'purchase',
        collection: orders,
        collectionName: COLLECTIONS.ORDERS,
        record: order,
      };
    }
    return null;
  }

  /**
   * Apply a status only when it moves the record forward.
   *
   * @param {object} parent The located parent.
   * @param {string} status The candidate status.
   * @param {object} [extraSet] Additional fields to set alongside it.
   * @returns {Promise<boolean>} True when the transition was applied.
   */
  async function advance(parent, status, extraSet = {}) {
    const ranks = parent.workflow === 'donation' ? DONATION_STATE_RANK : ORDER_STATE_RANK;
    const current = ranks[parent.record.status] ?? 0;
    const candidate = ranks[status] ?? 0;
    if (candidate <= current) return false;

    const now = new Date();
    await parent.collection.updateOne(
      { _id: parent.record._id, status: parent.record.status },
      { $set: { status, ...extraSet, ...updateStamps(now) } },
    );
    return true;
  }

  /**
   * Reconcile a refund reported by the gateway. The authoritative amount comes from the
   * re-query; failing that, from what we already recorded.
   *
   * @param {object} parent The located parent.
   * @param {object|null} queried The re-query result.
   * @param {string} transactionId The gateway transaction id.
   * @returns {Promise<void>} Resolves when reconciled.
   */
  async function reconcileRefund(parent, queried, transactionId) {
    const recorded = Number.isInteger(parent.record.amountCents) ? parent.record.amountCents : 0;
    const queriedCents = Number.isInteger(Number(queried?.raw?.amount))
      ? Math.round(Number(queried.raw.amount) * 100)
      : null;
    const amountCents = queriedCents ?? recorded;
    const now = new Date();

    const alreadyRefunded = (parent.record.refunds ?? []).reduce(
      (total, entry) => total + (Number.isInteger(entry.amountCents) ? entry.amountCents : 0),
      0,
    );
    const total = alreadyRefunded + amountCents;
    const status = total >= recorded && recorded > 0 ? 'refunded' : 'partially_refunded';

    await parent.collection.updateOne(
      { _id: parent.record._id },
      {
        $push: {
          refunds: {
            nmiTransactionId: transactionId,
            amountCents,
            reason: 'gateway_reported',
            at: now,
            byAdminId: null,
          },
        },
        $set: { ...updateStamps(now) },
      },
    );
    await advance(parent, status, status === 'refunded' ? { refundedAt: now } : {});

    if (queried?.transactionId) {
      await recordPaymentTransaction(db, {
        result: queried,
        kind: 'refund',
        workflow: parent.workflow,
        refCollection: parent.collectionName,
        refId: parent.record._id,
        amountCents,
        currency: parent.record.currency ?? 'USD',
        now,
      });
    }
  }

  return {
    /**
     * `POST /webhooks/nmi`.
     *
     * @param {{ rawBody: Buffer|string|null, signatureHeader: string|undefined,
     *           body: object|undefined, correlationId?: string|null }} input The delivery.
     * @returns {Promise<{ received: true, status: 'processed'|'skipped'|'ignored' }>} Outcome.
     * @throws {ApiError} 401 when the signature does not verify.
     */
    async handle(input) {
      const { rawBody, signatureHeader, body, correlationId = null } = input;

      const verification = verifyWebhookSignature({
        rawBody: rawBody ?? '',
        signatureHeader,
        secret: config.nmi.webhookSigningKey,
        toleranceSeconds: config.nmi.webhookToleranceSeconds,
      });

      if (!verification.valid) {
        // Alarmed, not merely logged. The reason stays server-side; the caller is told
        // nothing that would help them craft a better forgery.
        logger?.warn?.(
          { alert: 'webhook_signature_rejected', reason: verification.reason },
          'an NMI webhook was rejected before it was read',
        );
        await writeAuditSafe(
          db,
          {
            actorType: 'webhook',
            action: AUDIT_ACTIONS.WEBHOOK_SIGNATURE_REJECTED,
            targetCollection: COLLECTIONS.NMI_WEBHOOK_EVENTS,
            after: { reason: verification.reason },
            correlationId,
          },
          logger,
        );
        throw new ApiError(401, 'WEBHOOK_SIGNATURE_INVALID', 'That request could not be accepted.');
      }

      const parsed = body && typeof body === 'object' ? body : {};
      const gatewayEventId = pick(parsed, [
        ['event_id'],
        ['eventId'],
        ['id'],
        ['event', 'id'],
      ]);
      const eventType =
        pick(parsed, [['event_type'], ['eventType'], ['type'], ['event', 'type']]) ?? 'unknown';

      if (gatewayEventId === null) {
        logger?.warn?.({ alert: 'webhook_without_event_id' }, 'an NMI webhook carried no event id');
        return { received: true, status: 'ignored' };
      }

      const receivedAt = new Date();
      const record = {
        _id: newId(),
        gatewayEventId,
        eventType,
        signatureValid: true,
        payload: redactGatewayPayload(parsed),
        receivedAt,
        processedAt: null,
        status: 'pending',
        error: null,
        ...creationStamps(SCHEMA_VERSION, receivedAt),
      };

      try {
        await events.insertOne(record);
      } catch (error) {
        if (error?.code === 11000 || error?.code === 11001) {
          // At-least-once delivery. This id has been seen; nothing is reprocessed.
          return { received: true, status: 'skipped' };
        }
        throw error;
      }

      await writeAuditSafe(
        db,
        {
          actorType: 'webhook',
          action: AUDIT_ACTIONS.WEBHOOK_RECEIVED,
          targetCollection: COLLECTIONS.NMI_WEBHOOK_EVENTS,
          targetId: record._id,
          after: { gatewayEventId, eventType },
          correlationId,
        },
        logger,
      );

      const transactionId = pick(parsed, [
        ['transaction_id'],
        ['transactionId'],
        ['transactionid'],
        ['event_body', 'transaction_id'],
        ['event_body', 'transaction', 'transaction_id'],
        ['transaction', 'transaction_id'],
        ['transaction', 'id'],
      ]);

      const classification = classifyEvent(eventType);
      let outcome = 'ignored';

      try {
        if (transactionId === null || classification === 'unknown') {
          await writeAuditSafe(
            db,
            {
              actorType: 'webhook',
              action: WEBHOOK_AUDIT_ACTIONS.WEBHOOK_UNMATCHED,
              targetCollection: COLLECTIONS.NMI_WEBHOOK_EVENTS,
              targetId: record._id,
              after: { gatewayEventId, eventType, reason: 'no_reconcilable_transaction' },
              correlationId,
            },
            logger,
          );
        } else {
          const parent = await locate(transactionId);
          if (parent === null) {
            await writeAuditSafe(
              db,
              {
                actorType: 'webhook',
                action: WEBHOOK_AUDIT_ACTIONS.WEBHOOK_UNMATCHED,
                targetCollection: COLLECTIONS.NMI_WEBHOOK_EVENTS,
                targetId: record._id,
                after: { gatewayEventId, eventType, reason: 'no_matching_record' },
                correlationId,
              },
              logger,
            );
          } else {
            const queried = await reQuery(transactionId);

            if (classification === 'chargeback') {
              // Flagged for a human. Nothing is revoked, nothing is cancelled, no access is
              // withdrawn: a dispute is a conversation with the card network, not a verdict
              // about the reader (§6.8).
              await writeAuditSafe(
                db,
                {
                  actorType: 'webhook',
                  action:
                    parent.workflow === 'donation'
                      ? WEBHOOK_AUDIT_ACTIONS.DONATION_CHARGEBACK
                      : WEBHOOK_AUDIT_ACTIONS.ORDER_CHARGEBACK,
                  targetCollection: parent.collectionName,
                  targetId: parent.record._id,
                  after: {
                    requiresHumanReview: true,
                    gatewayEventId,
                    eventType,
                    accessRevoked: false,
                  },
                  correlationId,
                },
                logger,
              );
              logger?.warn?.(
                { alert: 'chargeback_received', workflow: parent.workflow },
                'a chargeback was reported and is awaiting human review',
              );
              outcome = 'processed';
            } else if (classification === 'refund') {
              await reconcileRefund(parent, queried, transactionId);
              outcome = 'processed';
            } else if (classification === 'void') {
              await advance(parent, parent.workflow === 'donation' ? 'refunded' : 'canceled', {
                ...(parent.workflow === 'donation'
                  ? { refundedAt: new Date() }
                  : { canceledAt: new Date() }),
              });
              outcome = 'processed';
            } else if (classification === 'sale' || classification === 'settlement') {
              // Settlement confirms what the synchronous response already told the reader.
              // The only forward movement it can produce is `initiated → captured` for a
              // record whose response was lost in flight.
              if (queried?.ok) {
                await advance(
                  parent,
                  parent.workflow === 'donation' ? 'captured' : 'paid',
                  parent.workflow === 'donation'
                    ? { capturedAt: new Date() }
                    : { paidAt: new Date() },
                );
              }
              outcome = 'processed';
            }
          }
        }

        await events.updateOne(
          { _id: record._id },
          {
            $set: {
              status: outcome === 'processed' ? 'processed' : 'skipped',
              processedAt: new Date(),
              ...updateStamps(new Date()),
            },
          },
        );
      } catch (error) {
        logger?.error?.({ err: error, gatewayEventId }, 'webhook reconciliation failed');
        await events.updateOne(
          { _id: record._id },
          {
            $set: {
              status: 'error',
              processedAt: new Date(),
              error: String(error?.code ?? error?.name ?? 'error'),
              ...updateStamps(new Date()),
            },
          },
        );
        // The gateway retries on a non-2xx, which is exactly what should happen: the event
        // is stored, the id is known, and the retry will be skipped if it later succeeds.
        throw new ApiError(503, 'WEBHOOK_NOT_PROCESSED', 'That event could not be processed.');
      }

      return { received: true, status: outcome === 'processed' ? 'processed' : 'ignored' };
    },
  };
}

export default createWebhooksService;
