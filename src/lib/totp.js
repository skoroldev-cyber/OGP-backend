/**
 * RFC 6238 time-based one-time passwords, built on `node:crypto`.
 *
 * MFA is mandatory for every admin account (§9.2.10). 30-second step, 6 digits,
 * SHA-1 (the algorithm every authenticator app implements), ±1 step of drift.
 *
 * The shared secret is a per-admin value stored as `admin_users.mfa.totpSecretEnc`.
 * Nothing here logs or returns a secret except the explicit provisioning helpers, which
 * are reachable only from the admin creation flow.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;
const DEFAULT_SECRET_BYTES = 20; // 160 bits — the RFC 4226 recommendation.
const DIGIT_MODULUS = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];

/**
 * Encode bytes as RFC 4648 base32 without padding.
 *
 * @param {Buffer} buffer Raw bytes.
 * @returns {string} Base32 text.
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode RFC 4648 base32. Padding, whitespace and lowercase are tolerated because humans
 * retype these secrets.
 *
 * @param {string} text Base32 text.
 * @returns {Buffer} Raw bytes.
 * @throws {TypeError} When the text contains a non-base32 symbol.
 */
export function base32Decode(text) {
  if (typeof text !== 'string') throw new TypeError('base32Decode: input must be a string.');
  const normalized = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const symbol of normalized) {
    const index = BASE32_ALPHABET.indexOf(symbol);
    if (index === -1) throw new TypeError('base32Decode: input contains a non-base32 symbol.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate a fresh TOTP secret.
 *
 * @param {number} [bytes] Secret length in bytes. Defaults to 20 (160 bits).
 * @returns {string} Base32-encoded secret.
 */
export function generateTotpSecret(bytes = DEFAULT_SECRET_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new RangeError('generateTotpSecret: bytes must be an integer between 16 and 64.');
  }
  return base32Encode(randomBytes(bytes));
}

function counterBuffer(counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

/**
 * HOTP (RFC 4226) for a specific counter.
 *
 * @param {Buffer} secret Raw secret bytes.
 * @param {number} counter Moving factor.
 * @param {number} digits Code length.
 * @returns {string} Zero-padded code.
 */
function hotp(secret, counter, digits) {
  const digest = createHmac('sha1', secret).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % DIGIT_MODULUS[digits]).padStart(digits, '0');
}

/**
 * Generate the TOTP code for an instant. Exposed for provisioning verification and tests.
 *
 * @param {string} secret Base32 secret.
 * @param {{ timestamp?: number, stepSeconds?: number, digits?: number }} [options] Options.
 * @returns {string} The current code.
 */
export function generateTotp(secret, options = {}) {
  const {
    timestamp = Date.now(),
    stepSeconds = DEFAULT_STEP_SECONDS,
    digits = DEFAULT_DIGITS,
  } = options;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError('generateTotp: digits must be 6, 7 or 8.');
  }
  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  return hotp(base32Decode(secret), counter, digits);
}

/**
 * Verify a submitted TOTP code against the ±window steps around now.
 *
 * The comparison is constant-time and the returned `delta` lets the caller reject replay
 * of a code already consumed in this step.
 *
 * @param {string} secret Base32 secret.
 * @param {string} code Submitted code.
 * @param {{ timestamp?: number, stepSeconds?: number, digits?: number, window?: number }}
 *        [options] Options.
 * @returns {{ valid: boolean, delta?: number }} Result; `delta` is the matching step offset.
 */
export function verifyTotp(secret, code, options = {}) {
  const {
    timestamp = Date.now(),
    stepSeconds = DEFAULT_STEP_SECONDS,
    digits = DEFAULT_DIGITS,
    window = DEFAULT_WINDOW,
  } = options;
  if (typeof secret !== 'string' || secret === '') return { valid: false };
  if (typeof code !== 'string') return { valid: false };
  const submitted = code.replace(/\s/g, '');
  if (submitted.length !== digits || !/^[0-9]+$/.test(submitted)) return { valid: false };

  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return { valid: false };
  }
  if (key.length === 0) return { valid: false };

  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  const submittedBuffer = Buffer.from(submitted, 'utf8');
  // Every step in the window is evaluated even after a match, so verification takes the
  // same time whether the code was right, wrong, or right one step ago.
  let matched = false;
  let matchDelta = 0;
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = Buffer.from(hotp(key, counter + delta, digits), 'utf8');
    const equal =
      candidate.length === submittedBuffer.length && timingSafeEqual(candidate, submittedBuffer);
    if (equal && !matched) {
      matched = true;
      matchDelta = delta;
    }
  }
  return matched ? { valid: true, delta: matchDelta } : { valid: false };
}

/**
 * Build the `otpauth://` provisioning URI an authenticator app scans.
 *
 * @param {{ secret: string, accountName: string, issuer?: string, digits?: number,
 *           periodSeconds?: number }} input Provisioning details.
 * @returns {string} The otpauth URI.
 */
export function buildOtpAuthUri({
  secret,
  accountName,
  issuer = 'One Global People',
  digits = DEFAULT_DIGITS,
  periodSeconds = DEFAULT_STEP_SECONDS,
}) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('buildOtpAuthUri: secret is required.');
  }
  if (typeof accountName !== 'string' || accountName === '') {
    throw new TypeError('buildOtpAuthUri: accountName is required.');
  }
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export const TOTP_PARAMETERS = Object.freeze({
  stepSeconds: DEFAULT_STEP_SECONDS,
  digits: DEFAULT_DIGITS,
  window: DEFAULT_WINDOW,
  secretBytes: DEFAULT_SECRET_BYTES,
  algorithm: 'SHA1',
});
