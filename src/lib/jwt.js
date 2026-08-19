/**
 * Minimal HS256 JSON Web Tokens, built on `node:crypto`.
 *
 * Only HS256 is implemented and only HS256 is accepted: the `alg` header is compared
 * against a constant before any signature work, which closes the `alg: none` and
 * algorithm-confusion families outright.
 *
 * Used exclusively for admin access and refresh tokens. Readers never receive a JWT —
 * their bearer token is opaque and database-backed (see `lib/tokens.js`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ulid } from './ids.js';

const ALGORITHM = 'HS256';
const HEADER = Object.freeze({ alg: ALGORITHM, typ: 'JWT' });
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER), 'utf8').toString('base64url');
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

/** Access tokens are short-lived (§9.4: 15 minutes). */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
/** Refresh tokens rotate and are bound to a server-side record. */
export const REFRESH_TOKEN_TTL_SEC = 12 * 60 * 60;

export class JwtError extends Error {
  /**
   * @param {string} code Machine-readable reason.
   * @param {string} message Human-readable reason.
   */
  constructor(code, message) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSegment(segment) {
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JwtError('JWT_MALFORMED', 'Token segment is not a JSON object.');
  }
  return parsed;
}

function signSegments(signingInput, secret) {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest();
}

/**
 * Sign a JWT.
 *
 * @param {object} claims Claims to embed. `iat`, `exp` and `jti` are added automatically.
 * @param {{ secret: string, expiresInSec?: number, issuer?: string, audience?: string,
 *           subject?: string, now?: number, jti?: string }} options Signing options.
 * @returns {{ token: string, jti: string, expiresAt: Date }} The token and its metadata.
 */
export function signJwt(claims, options) {
  const { secret, expiresInSec = ACCESS_TOKEN_TTL_SEC, issuer, audience, subject, now = Date.now() } =
    options ?? {};
  if (typeof secret !== 'string' || secret === '') {
    throw new JwtError('JWT_NO_SECRET', 'A signing secret is required.');
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new JwtError('JWT_MALFORMED', 'Claims must be a plain object.');
  }
  const issuedAt = Math.floor(now / 1000);
  const jti = options.jti ?? ulid();
  const payload = {
    ...claims,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + expiresInSec,
    jti,
  };
  if (issuer !== undefined) payload.iss = issuer;
  if (audience !== undefined) payload.aud = audience;
  if (subject !== undefined) payload.sub = subject;

  const signingInput = `${ENCODED_HEADER}.${encodeSegment(payload)}`;
  const signature = signSegments(signingInput, secret).toString('base64url');
  return {
    token: `${signingInput}.${signature}`,
    jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * Verify a JWT and return its claims.
 *
 * @param {string} token The compact token.
 * @param {{ secret: string, issuer?: string, audience?: string, now?: number,
 *           clockToleranceSec?: number }} options Verification options.
 * @returns {object} The verified claims.
 * @throws {JwtError} On any structural, signature, or temporal failure.
 */
export function verifyJwt(token, options) {
  const {
    secret,
    issuer,
    audience,
    now = Date.now(),
    clockToleranceSec = DEFAULT_CLOCK_TOLERANCE_SEC,
  } = options ?? {};
  if (typeof secret !== 'string' || secret === '') {
    throw new JwtError('JWT_NO_SECRET', 'A verification secret is required.');
  }
  if (typeof token !== 'string') {
    throw new JwtError('JWT_MALFORMED', 'Token must be a string.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('JWT_MALFORMED', 'Token must have three segments.');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header;
  try {
    header = decodeSegment(headerSegment);
  } catch {
    throw new JwtError('JWT_MALFORMED', 'Token header is not decodable.');
  }
  if (header.alg !== ALGORITHM) {
    throw new JwtError('JWT_BAD_ALGORITHM', 'Only HS256 tokens are accepted.');
  }

  const expected = signSegments(`${headerSegment}.${payloadSegment}`, secret);
  const provided = Buffer.from(signatureSegment, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    throw new JwtError('JWT_BAD_SIGNATURE', 'Token signature does not verify.');
  }

  let payload;
  try {
    payload = decodeSegment(payloadSegment);
  } catch {
    throw new JwtError('JWT_MALFORMED', 'Token payload is not decodable.');
  }

  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number') {
    throw new JwtError('JWT_MALFORMED', 'Token has no expiry.');
  }
  if (seconds > payload.exp + clockToleranceSec) {
    throw new JwtError('JWT_EXPIRED', 'Token has expired.');
  }
  if (typeof payload.nbf === 'number' && seconds + clockToleranceSec < payload.nbf) {
    throw new JwtError('JWT_NOT_ACTIVE', 'Token is not valid yet.');
  }
  if (issuer !== undefined && payload.iss !== issuer) {
    throw new JwtError('JWT_BAD_ISSUER', 'Token issuer does not match.');
  }
  if (audience !== undefined && payload.aud !== audience) {
    throw new JwtError('JWT_BAD_AUDIENCE', 'Token audience does not match.');
  }
  return payload;
}

/**
 * Read a token's claims without verifying it. For logging and diagnostics only — never
 * for an authorization decision.
 *
 * @param {string} token The compact token.
 * @returns {object|null} The claims, or null when undecodable.
 */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return decodeSegment(parts[1]);
  } catch {
    return null;
  }
}
