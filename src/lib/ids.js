/**
 * Identifier generation.
 *
 * `_id` on every document is a server-generated ULID string (§9.2): lexicographically
 * sortable by creation time, 128 bits, no coordination required, no MongoDB ObjectId
 * leakage of host or process identity.
 *
 * Opaque tokens (share links, invitation codes, access grants) use a separate
 * nanoid-style generator: 21 characters from a 64-symbol URL-safe alphabet, drawn from
 * `crypto.randomBytes` with no modulo bias.
 */

import { randomBytes, randomFillSync } from 'node:crypto';

/** Crockford base32 — no I, L, O or U, so codes cannot be misread aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_BYTES = 10;
const MAX_TIME = 281474976710655; // 2^48 - 1

/** URL-safe, 64 symbols — a power of two, so 6 random bits map without rejection. */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DEFAULT_TOKEN_LENGTH = 21;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const scratch = Buffer.allocUnsafe(RANDOM_BYTES);

let lastTime = -1;
/** Randomness of the last ULID minted in `lastTime`, as 16 base32 symbol indices. */
let lastRandom = new Uint8Array(RANDOM_LENGTH);

function encodeTime(time) {
  let out = '';
  let remaining = time;
  for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function fillRandom(target) {
  randomFillSync(scratch);
  // 10 bytes -> 16 base32 symbols, 5 bits each.
  let bitBuffer = 0;
  let bitCount = 0;
  let index = 0;
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    bitBuffer = (bitBuffer << 8) | scratch[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      target[index] = (bitBuffer >>> bitCount) & 31;
      index += 1;
    }
  }
}

/** Increment the stored randomness by one, so ULIDs minted in the same millisecond sort. */
function incrementRandom(target) {
  for (let i = RANDOM_LENGTH - 1; i >= 0; i -= 1) {
    if (target[i] < 31) {
      target[i] += 1;
      return true;
    }
    target[i] = 0;
  }
  return false;
}

function encodeRandom(source) {
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) out += CROCKFORD[source[i]];
  return out;
}

/**
 * Monotonic ULID.
 *
 * @param {number} [time] Milliseconds since the epoch. Defaults to now.
 * @returns {string} A 26-character ULID.
 */
export function ulid(time = Date.now()) {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError('ulid: time must be an integer between 0 and 2^48 - 1.');
  }
  if (time === lastTime) {
    if (!incrementRandom(lastRandom)) {
      // Randomness exhausted inside one millisecond (2^80 ids). Advance the clock field.
      lastTime += 1;
      fillRandom(lastRandom);
    }
  } else if (time < lastTime) {
    // Clock stepped backwards. Stay monotonic rather than trusting the wall clock.
    if (!incrementRandom(lastRandom)) {
      lastTime += 1;
      fillRandom(lastRandom);
    }
  } else {
    lastTime = time;
    fillRandom(lastRandom);
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom);
}

/**
 * The document `_id` factory. Alias of {@link ulid}, named for intent at call sites.
 *
 * @returns {string} A 26-character ULID.
 */
export function newId() {
  return ulid();
}

/**
 * @param {unknown} value Candidate identifier.
 * @returns {boolean} True when the value is a syntactically valid ULID.
 */
export function isUlid(value) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/**
 * Extract the creation timestamp encoded in a ULID.
 *
 * @param {string} value A ULID.
 * @returns {Date|null} The encoded instant, or null when the input is not a ULID.
 */
export function ulidTime(value) {
  if (!isUlid(value)) return null;
  let time = 0;
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    time = time * 32 + CROCKFORD.indexOf(value[i]);
  }
  return new Date(time);
}

/**
 * Opaque, URL-safe token. Used for share tokens, invitation codes and access grants —
 * anywhere a value appears in a link and must not be guessable or enumerable.
 *
 * @param {number} [length] Token length. Defaults to 21 characters (~125 bits).
 * @returns {string} The token.
 */
export function opaqueToken(length = DEFAULT_TOKEN_LENGTH) {
  if (!Number.isInteger(length) || length < 8 || length > 128) {
    throw new RangeError('opaqueToken: length must be an integer between 8 and 128.');
  }
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += TOKEN_ALPHABET[bytes[i] & 63];
  return out;
}

/**
 * The 21-character share/invitation token used in `/s/:token` URLs (§9.2.6).
 *
 * @returns {string} A 21-character URL-safe token.
 */
export function shareToken() {
  return opaqueToken(DEFAULT_TOKEN_LENGTH);
}

/**
 * A namespaced identifier, e.g. `prefixedId('REL')` → `REL_01J...`.
 * Used where an id is read by a human (release ids, receipt references).
 *
 * @param {string} prefix Short uppercase namespace.
 * @returns {string} The prefixed identifier.
 */
export function prefixedId(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(prefix)) {
    throw new TypeError('prefixedId: prefix must be 2–8 uppercase alphanumeric characters.');
  }
  return `${prefix}_${ulid()}`;
}

/**
 * Split a prefixed identifier.
 *
 * @param {string} value A value produced by {@link prefixedId}.
 * @returns {{ prefix: string, id: string }|null} Parts, or null when unparseable.
 */
export function parsePrefixedId(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('_');
  if (separator < 1) return null;
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isUlid(id)) return null;
  return { prefix, id };
}

/** Test seam: reset monotonic state so unit tests are deterministic. */
export function resetMonotonicState() {
  lastTime = -1;
  lastRandom = new Uint8Array(RANDOM_LENGTH);
}
