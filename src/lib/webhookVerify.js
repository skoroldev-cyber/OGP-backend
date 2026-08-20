import { createHmac, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';

const DEFAULT_TOLERANCE_SECONDS = 300;

export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  let timestamp = null;
  let signature = null;
  for (const segment of header.split(',')) {
    const separator = segment.indexOf('=');
    if (separator === -1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 's') signature = value;
  }
  if (!Number.isFinite(timestamp) || typeof signature !== 'string' || signature === '') {
    return null;
  }
  return { timestamp, signature };
}

export function verifyWebhookSignature(input) {
  const {
    rawBody,
    signatureHeader,
    secret = config.nmi.webhookSigningKey,
    toleranceSeconds = config.nmi.webhookToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    now = Date.now(),
  } = input ?? {};

  if (typeof secret !== 'string' || secret === '') {
    return { valid: false, reason: 'no_secret' };
  }
  if (rawBody === undefined || rawBody === null) {
    return { valid: false, reason: 'malformed' };
  }

  let timestamp = input?.timestamp;
  let signature = input?.signature;
  if (timestamp === undefined || signature === undefined) {
    const parsed = parseSignatureHeader(signatureHeader);
    if (parsed === null) return { valid: false, reason: 'malformed' };
    timestamp = parsed.timestamp;
    signature = parsed.signature;
  }

  const skewSeconds = Math.abs(Math.floor(now / 1000) - timestamp);
  if (skewSeconds > toleranceSeconds) {
    return { valid: false, reason: 'stale', timestamp };
  }

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    bodyBuffer,
  ]);
  const expected = createHmac('sha256', secret).update(signedPayload).digest();

  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return { valid: false, reason: 'malformed', timestamp };
  }
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'bad_signature', timestamp };
  }
  return { valid: true, timestamp };
}

export function signWebhookBody({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('signWebhookBody: a signing secret is required.');
  }
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), bodyBuffer]);
  const digest = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},s=${digest}`;
}
