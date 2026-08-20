import { randomBytes, randomFillSync } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_BYTES = 10;
const MAX_TIME = 281474976710655;

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DEFAULT_TOKEN_LENGTH = 21;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const scratch = Buffer.allocUnsafe(RANDOM_BYTES);

let lastTime = -1;
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

export function ulid(time = Date.now()) {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError('ulid: time must be an integer between 0 and 2^48 - 1.');
  }
  if (time === lastTime) {
    if (!incrementRandom(lastRandom)) {
      lastTime += 1;
      fillRandom(lastRandom);
    }
  } else if (time < lastTime) {
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

export function newId() {
  return ulid();
}

export function isUlid(value) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

export function ulidTime(value) {
  if (!isUlid(value)) return null;
  let time = 0;
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    time = time * 32 + CROCKFORD.indexOf(value[i]);
  }
  return new Date(time);
}

export function opaqueToken(length = DEFAULT_TOKEN_LENGTH) {
  if (!Number.isInteger(length) || length < 8 || length > 128) {
    throw new RangeError('opaqueToken: length must be an integer between 8 and 128.');
  }
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += TOKEN_ALPHABET[bytes[i] & 63];
  return out;
}

export function shareToken() {
  return opaqueToken(DEFAULT_TOKEN_LENGTH);
}

export function prefixedId(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(prefix)) {
    throw new TypeError('prefixedId: prefix must be 2–8 uppercase alphanumeric characters.');
  }
  return `${prefix}_${ulid()}`;
}

export function parsePrefixedId(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('_');
  if (separator < 1) return null;
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isUlid(id)) return null;
  return { prefix, id };
}

export function resetMonotonicState() {
  lastTime = -1;
  lastRandom = new Uint8Array(RANDOM_LENGTH);
}
