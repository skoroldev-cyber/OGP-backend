import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';

const SESSION_TOKEN_BYTES = 32;
const SIGNATURE_BYTES = 32;
const TOKEN_VERSION = 'v1';

function base64url(buffer) {
  return buffer.toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function mintSessionToken() {
  return base64url(randomBytes(SESSION_TOKEN_BYTES));
}

export function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('hashSessionToken: token must be a non-empty string.');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function bearerFromHeader(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)$/.exec(header.trim());
  return match ? match[1] : null;
}

export function rateLimitKeyForToken(token) {
  return createHmac('sha256', config.secrets.sessionToken)
    .update(token, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function sessionSigningSecrets() {
  const secrets = [config.secrets.sessionToken];
  if (config.secrets.sessionTokenPrevious) secrets.push(config.secrets.sessionTokenPrevious);
  return secrets;
}

export function receiptSigningSecrets() {
  const secrets = [config.secrets.receiptSigning];
  if (config.secrets.sessionTokenPrevious) secrets.push(config.secrets.sessionTokenPrevious);
  return secrets;
}

function sign(payloadPart, secret) {
  return base64url(createHmac('sha256', secret).update(payloadPart, 'utf8').digest());
}

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

const RECEIPT_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export function signReceiptToken({ receiptNumber, ttlMs = RECEIPT_TTL_MS, now = Date.now() }) {
  if (typeof receiptNumber !== 'string' || receiptNumber === '') {
    throw new TypeError('signReceiptToken: receiptNumber is required.');
  }
  return signValue(
    { p: 'receipt', r: receiptNumber },
    { secret: config.secrets.receiptSigning, ttlMs, now },
  );
}

export function verifyReceiptToken(token, receiptNumber, { now = Date.now() } = {}) {
  const result = verifySignedValue(token, { secrets: receiptSigningSecrets(), now });
  if (!result.valid) return result;
  if (result.claims.p !== 'receipt') return { valid: false, reason: 'wrong_purpose' };
  if (!constantTimeEqual(String(result.claims.r ?? ''), String(receiptNumber))) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true };
}

export function signAccessToken({ grantId }) {
  if (typeof grantId !== 'string' || grantId === '') {
    throw new TypeError('signAccessToken: grantId is required.');
  }
  return signValue({ p: 'grant', g: grantId }, { secret: config.secrets.receiptSigning, ttlMs: null });
}

export function verifyAccessToken(token) {
  const result = verifySignedValue(token, { secrets: receiptSigningSecrets() });
  if (!result.valid) return result;
  if (result.claims.p !== 'grant' || typeof result.claims.g !== 'string') {
    return { valid: false, reason: 'wrong_purpose' };
  }
  return { valid: true, grantId: result.claims.g };
}

export function signSessionScopedValue(claims, ttlMs) {
  return signValue(claims, { secret: config.secrets.sessionToken, ttlMs });
}

export function verifySessionScopedValue(token) {
  return verifySignedValue(token, { secrets: sessionSigningSecrets() });
}
