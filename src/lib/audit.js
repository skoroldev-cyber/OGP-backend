/**
 * Append-only audit trail (§9.2.10).
 *
 * Every admin mutation, every payment state change and every canonical-lock rejection
 * lands here. There is no update path and no delete path — the collection is written and
 * read, never edited.
 *
 * Before/after snapshots are redacted on the way in: a password hash, a TOTP secret, a
 * session token hash or a payment token must never be preserved in the audit trail, and
 * the trail must never become a back door around the anti-profiling rules.
 */

import { COLLECTIONS } from '../db/collections.js';
import { AUDIT_ACTOR_TYPES, PROHIBITED_FIELDS, SCHEMA_VERSION } from '../config/constants.js';
import { newId } from './ids.js';

/** Keys whose values are always replaced with a marker, at any depth. */
const SECRET_KEYS = new Set([
  'passwordhash',
  'password',
  'totpsecretenc',
  'totpsecret',
  'tokenhash',
  'sessiontoken',
  'paymenttoken',
  'securitykey',
  'security_key',
  'refreshtokenhash',
  'authorization',
  'cvv',
  'ccnumber',
  'ccexp',
  'cardnumber',
]);

/** Keys that may never be persisted at all — dropped rather than masked. */
const FORBIDDEN_KEYS = new Set(PROHIBITED_FIELDS.map((field) => field.toLowerCase()));

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

/**
 * Deeply copy a value, masking secrets and dropping prohibited keys.
 *
 * @param {unknown} value Any value.
 * @param {number} [depth] Internal recursion depth.
 * @returns {unknown} A safe copy.
 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) {
    const trimmed = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) trimmed.push(`…${value.length - MAX_ARRAY_ITEMS} more`);
    return trimmed;
  }
  if (typeof value !== 'object') return REDACTED;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(lowered)) continue;
    out[key] = SECRET_KEYS.has(lowered) ? REDACTED : redact(nested, depth + 1);
  }
  return out;
}

/**
 * Write one audit entry.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ actorType: 'admin'|'system'|'webhook', actorId?: string|null, action: string,
 *           targetCollection?: string|null, targetId?: string|null, before?: unknown,
 *           after?: unknown, correlationId?: string|null, at?: Date }} entry The entry.
 * @returns {Promise<string>} The audit entry `_id`.
 */
export async function writeAudit(db, entry) {
  const {
    actorType,
    actorId = null,
    action,
    targetCollection = null,
    targetId = null,
    before,
    after,
    correlationId = null,
    at = new Date(),
  } = entry ?? {};

  if (!AUDIT_ACTOR_TYPES.includes(actorType)) {
    throw new TypeError(
      `writeAudit: actorType must be one of ${AUDIT_ACTOR_TYPES.join(', ')}; received "${actorType}".`,
    );
  }
  if (typeof action !== 'string' || action.trim() === '') {
    throw new TypeError('writeAudit: action is required.');
  }

  const document = {
    _id: newId(),
    actorType,
    actorId,
    action: action.trim(),
    targetCollection,
    targetId,
    before: before === undefined ? null : redact(before),
    after: after === undefined ? null : redact(after),
    correlationId,
    at,
    createdAt: at,
    updatedAt: at,
    schemaVersion: SCHEMA_VERSION,
  };

  await db.collection(COLLECTIONS.AUDIT_LOG).insertOne(document);
  return document._id;
}

/**
 * Write an audit entry without letting a failure propagate. For paths where the audit is
 * secondary to the operation (webhook processing, background sweeps) — an admin mutation
 * should use {@link writeAudit} and fail loudly instead.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {object} entry The entry, as for {@link writeAudit}.
 * @param {{ error: Function }} [logger] Logger for the swallowed failure.
 * @returns {Promise<string|null>} The audit entry `_id`, or null when the write failed.
 */
export async function writeAuditSafe(db, entry, logger) {
  try {
    return await writeAudit(db, entry);
  } catch (error) {
    if (logger && typeof logger.error === 'function') {
      logger.error({ err: error, action: entry?.action }, 'audit write failed');
    }
    return null;
  }
}

/** Canonical action strings, so the same event is never logged under two names. */
export const AUDIT_ACTIONS = Object.freeze({
  UNIT_SUBMIT_REVIEW: 'unit.submit_review',
  UNIT_APPROVE: 'unit.approve',
  UNIT_PUBLISH: 'unit.publish',
  UNIT_UPDATE: 'unit.update',
  CANONICAL_LOCK_REJECTED: 'canonical_lock.rejected',
  MANUSCRIPT_UPDATE: 'manuscript.update',
  RESONANCE_NODE_VALIDATE: 'resonance_node.validate',
  SHARING_PROMPT_UPDATE: 'sharing_prompt.update',
  SHARING_PROMPT_ACTIVATE: 'sharing_prompt.activate',
  COHORT_UPDATE: 'cohort.update',
  INVITATION_CREATE: 'invitation.create',
  INVITATION_SEND_WELCOME: 'invitation.send_welcome',
  INVITATION_REDEEM: 'invitation.redeem',
  DONATION_CAPTURE: 'donation.capture',
  DONATION_REFUND: 'donation.refund',
  ORDER_CREATE: 'order.create',
  ORDER_REFUND: 'order.refund',
  ORDER_FULFILL: 'order.fulfill',
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_SIGNATURE_REJECTED: 'webhook.signature_rejected',
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGOUT: 'admin.logout',
  ADMIN_CREATE: 'admin.create',
  ADMIN_UPDATE: 'admin.update',
  SESSION_ERASED: 'session.erased',
  FAMILY_WITHDRAWN: 'family.withdrawn',
});
