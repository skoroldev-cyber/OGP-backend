/**
 * Token minting, hashing and signing.
 *
 * Three distinct mechanisms live here; they must not be confused:
 *
 * 1. **Reader session tokens** — 256 bits of randomness, returned once, never stored.
 *    `reading_sessions.tokenHash` holds the plain SHA-256 of the bearer value, exactly as
 *    BUILD_CONTRACT §4.1/§9.2.4 specify. There is no secret in this path, so rotating
 *    `SESSION_TOKEN_SECRET` never invalidates a reader's place in the manuscript.
 *
 * 2. **Signed value tokens** — HMAC-SHA256 over a compact payload with an optional expiry.
 *    Used for receipt links, transcript access grants and any other value that appears in
 *    a URL and must be verifiable without a database round trip. Verification accepts a
 *    list of secrets so `SESSION_TOKEN_SECRET_PREVIOUS` keeps links working across a
 *    rotation window.
 *
 * 3. **Constant-time comparison** helpers, used everywhere a secret is compared.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';

const SESSION_TOKEN_BYTES = 32; // 256 bits
const SIGNATURE_BYTES = 32;
const TOKEN_VERSION = 'v1';

function base64url(buffer) {
  return buffer.toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

/**
 * Constant-time string comparison. Length is not secret; content is.
 *
 * @param {string} a First value.
 * @param {string} b Second value.
 * @returns {boolean} True when the values are identical.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the failure costs the same as a mismatch.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/* -------------------------------------------------------------------------- */
/* Reader session tokens                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Mint a reader session bearer token. Returned to the client exactly once.
 *
 * @returns {string} 43-character base64url value carrying 256 bits of entropy.
 */
export function mintSessionToken() {
  return base64url(randomBytes(SESSION_TOKEN_BYTES));
}

/**
 * Hash a bearer token for storage and lookup.
 *
 * @param {string} token The raw bearer token.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
export function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('hashSessionToken: token must be a non-empty string.');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Extract a bearer token from an Authorization header value.
 *
 * @param {string|undefined} header Raw header value.
 * @returns {string|null} The token, or null when the header is absent or malformed.
 */
export function bearerFromHeader(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Stable, non-reversible key for rate limiting a session without touching the database.
 * Derived with the session HMAC secret so the value cannot be correlated back to a
 * bearer token if a rate-limit store is ever exposed. Never persisted.
 *
 * @param {string} token The raw bearer token.
 * @returns {string} A 24-character hex key.
 */
export function rateLimitKeyForToken(token) {
  return createHmac('sha256', config.secrets.sessionToken)
    .update(token, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/* -------------------------------------------------------------------------- */
/* Signed value tokens                                                         */
/* -------------------------------------------------------------------------- */

/** The session secret plus its predecessor, newest first. */
export function sessionSigningSecrets() {
  const secrets = [config.secrets.sessionToken];
  if (config.secrets.sessionTokenPrevious) secrets.push(config.secrets.sessionTokenPrevious);
  return secrets;
}

/** The receipt secret plus the session predecessor, so one rotation window covers both. */
export function receiptSigningSecrets() {
  const secrets = [config.secrets.receiptSigning];
  if (config.secrets.sessionTokenPrevious) secrets.push(config.secrets.sessionTokenPrevious);
  return secrets;
}

function sign(payloadPart, secret) {
  return base64url(createHmac('sha256', secret).update(payloadPart, 'utf8').digest());
}

/**
 * Produce a self-describing signed token: `v1.<payload>.<signature>`.
 *
 * @param {object} claims Small JSON-serialisable claim set. Never put PII in here.
 * @param {{ secret: string, ttlMs?: number|null, now?: number }} options Signing options.
 * @returns {string} The signed token.
 */
export function signValue(claims, { secret, ttlMs = null, now = Date.now() }) {
  if (!secret) throw new TypeError('signValue: a signing secret is required.');
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new TypeError('signValue: claims must be a plain object.');
  }
  const body = { ...claims, iat: Math.floor(now / 1000) };
  if (ttlMs !== null) body.exp = Math.floor((now + ttlMs) / 1000);
  const payloadPart = base64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const signedPart = `${TOKEN_VERSION}.${payloadPart}`;
  return `${signedPart}.${sign(signedPart, secret)}`;
}

/**
 * Verify a token produced by {@link signValue} against one or more secrets.
 *
 * @param {string} token The token.
 * @param {{ secrets: string[], now?: number }} options Verification options.
 * @returns {{ valid: boolean, reason?: string, claims?: object, secretIndex?: number }} Result.
 */
export function verifySignedValue(token, { secrets, now = Date.now() }) {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { valid: false, reason: 'malformed' };
  }
  const signedPart = `${parts[0]}.${parts[1]}`;
  const provided = fromBase64url(parts[2]);
  if (provided.length !== SIGNATURE_BYTES) return { valid: false, reason: 'malformed' };

  let matchedIndex = -1;
  for (let i = 0; i < secrets.length; i += 1) {
    if (!secrets[i]) continue;
    const expected = createHmac('sha256', secrets[i]).update(signedPart, 'utf8').digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex === -1) return { valid: false, reason: 'bad_signature' };

  let claims;
  try {
    claims = JSON.parse(fromBase64url(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= now) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims, secretIndex: matchedIndex };
}

/* -------------------------------------------------------------------------- */
/* Purpose-built signed tokens                                                 */
/* -------------------------------------------------------------------------- */

/** Receipt links stay valid for 400 days — long enough for an accounting cycle. */
const RECEIPT_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * Sign the `?t=` parameter of `GET /commerce/receipts/:receiptNumber`.
 *
 * @param {{ receiptNumber: string, ttlMs?: number, now?: number }} input Receipt reference.
 * @returns {string} The signed token.
 */
export function signReceiptToken({ receiptNumber, ttlMs = RECEIPT_TTL_MS, now = Date.now() }) {
  if (typeof receiptNumber !== 'string' || receiptNumber === '') {
    throw new TypeError('signReceiptToken: receiptNumber is required.');
  }
  return signValue(
    { p: 'receipt', r: receiptNumber },
    { secret: config.secrets.receiptSigning, ttlMs, now },
  );
}

/**
 * Verify a receipt token and confirm it names the requested receipt.
 *
 * @param {string} token Signed token from the URL.
 * @param {string} receiptNumber The receipt number being requested.
 * @param {{ now?: number }} [options] Clock override for tests.
 * @returns {{ valid: boolean, reason?: string }} Result.
 */
export function verifyReceiptToken(token, receiptNumber, { now = Date.now() } = {}) {
  const result = verifySignedValue(token, { secrets: receiptSigningSecrets(), now });
  if (!result.valid) return result;
  if (result.claims.p !== 'receipt') return { valid: false, reason: 'wrong_purpose' };
  if (!constantTimeEqual(String(result.claims.r ?? ''), String(receiptNumber))) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true };
}

/**
 * Mint a non-expiring digital transcript access token (§6.6: the grant URL works without
 * an account and does not expire; revocation is a database flag, not a clock).
 *
 * @param {{ grantId: string }} input Grant reference.
 * @returns {string} The signed access token.
 */
export function signAccessToken({ grantId }) {
  if (typeof grantId !== 'string' || grantId === '') {
    throw new TypeError('signAccessToken: grantId is required.');
  }
  return signValue({ p: 'grant', g: grantId }, { secret: config.secrets.receiptSigning, ttlMs: null });
}

/**
 * Verify a transcript access token. Revocation is checked by the caller against
 * `digital_access_grants.revoked` — a valid signature is necessary, never sufficient.
 *
 * @param {string} token The access token.
 * @returns {{ valid: boolean, reason?: string, grantId?: string }} Result.
 */
export function verifyAccessToken(token) {
  const result = verifySignedValue(token, { secrets: receiptSigningSecrets() });
  if (!result.valid) return result;
  if (result.claims.p !== 'grant' || typeof result.claims.g !== 'string') {
    return { valid: false, reason: 'wrong_purpose' };
  }
  return { valid: true, grantId: result.claims.g };
}

/**
 * Sign a short-lived value scoped to a reader session, using the session secret pair so a
 * rotation window does not break in-flight links.
 *
 * @param {object} claims Claim set.
 * @param {number} ttlMs Lifetime in milliseconds.
 * @returns {string} The signed token.
 */
export function signSessionScopedValue(claims, ttlMs) {
  return signValue(claims, { secret: config.secrets.sessionToken, ttlMs });
}

/**
 * Verify a value signed by {@link signSessionScopedValue}, accepting the previous secret.
 *
 * @param {string} token The token.
 * @returns {{ valid: boolean, reason?: string, claims?: object, secretIndex?: number }} Result.
 */
export function verifySessionScopedValue(token) {
  return verifySignedValue(token, { secrets: sessionSigningSecrets() });
}
