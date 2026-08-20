import { COLLECTIONS } from '../db/collections.js';
import { AUDIT_ACTOR_TYPES, PROHIBITED_FIELDS, SCHEMA_VERSION } from '../config/constants.js';
import { newId } from './ids.js';

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

const FORBIDDEN_KEYS = new Set(PROHIBITED_FIELDS.map((field) => field.toLowerCase()));

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

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
