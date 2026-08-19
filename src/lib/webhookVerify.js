/**
 * Webhook signature verification (§9.6).
 *
 * NMI signs each webhook with an HMAC-SHA256 over `<timestamp>.<raw body>` and presents it
 * in a `Webhook-Signature: t=<unix seconds>,s=<hex digest>` header. Verification must run
 * against the **raw** body — re-serialising parsed JSON changes the bytes and the signature
 * will never match. `app.js` preserves `request.rawBody` for exactly this reason.
 *
 * A signature that verifies but carries a timestamp more than five minutes from our clock
 * is rejected: a captured request must not be replayable forever.
 *
 * Verification failures are alarmed, not merely logged (§9.10) — a spike is the signature
 * of an attacker probing the endpoint.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Parse a `t=…,s=…` signature header.
 *
 * @param {string|undefined} header Raw header value.
 * @returns {{ timestamp: number, signature: string }|null} Parts, or null when malformed.
 */
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

/**
 * Verify a timestamped HMAC-SHA256 webhook signature.
 *
 * @param {{ rawBody: string|Buffer, signatureHeader?: string, timestamp?: number,
 *           signature?: string, secret?: string, toleranceSeconds?: number, now?: number }}
 *        input Verification input. Provide either `signatureHeader` or the explicit
 *        `timestamp` + `signature` pair.
 * @returns {{ valid: boolean, reason?: 'no_secret'|'malformed'|'stale'|'bad_signature',
 *             timestamp?: number }} Result. `reason` is for server-side logs only; the
 *          endpoint returns an opaque rejection.
 */
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

/**
 * Produce a signature for a body. Used by the webhook replay tool and the staging test
 * harness (§6.15.3) — never in a request path.
 *
 * @param {{ rawBody: string|Buffer, secret: string, timestamp?: number }} input Signing input.
 * @returns {string} A `t=…,s=…` header value.
 */
export function signWebhookBody({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('signWebhookBody: a signing secret is required.');
  }
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), bodyBuffer]);
  const digest = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},s=${digest}`;
}
