import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'scrypt';
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

function assertPassword(password) {
  if (typeof password !== 'string') {
    throw new TypeError('hash: password must be a string.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(`hash: password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password));
  if (classes.length < 3) {
    return {
      ok: false,
      reason: 'Password must combine at least three of: lowercase, uppercase, digits, symbols.',
    };
  }
  return { ok: true };
}

export async function hashPassword(password, options = {}) {
  assertPassword(password);
  const cost = options.cost ?? COST;
  const blockSize = options.blockSize ?? BLOCK_SIZE;
  const parallelism = options.parallelism ?? PARALLELISM;
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: Math.max(MAX_MEMORY, 128 * cost * blockSize * 2),
  });
  return [
    ALGORITHM,
    cost,
    blockSize,
    parallelism,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function parseEncodedHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('$');
  if (parts.length !== 6) return null;
  const [algorithm, costRaw, blockSizeRaw, parallelismRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== ALGORITHM) return null;
  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelism = Number(parallelismRaw);
  if (!Number.isInteger(cost) || cost < 2 || (cost & (cost - 1)) !== 0) return null;
  if (!Number.isInteger(blockSize) || blockSize < 1) return null;
  if (!Number.isInteger(parallelism) || parallelism < 1) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    hash = Buffer.from(hashRaw, 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length === 0) return null;
  return { algorithm, cost, blockSize, parallelism, salt, hash };
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parsed = parseEncodedHash(encoded);
  if (!parsed) return false;
  let derived;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.cost,
      r: parsed.blockSize,
      p: parsed.parallelism,
      maxmem: Math.max(MAX_MEMORY, 128 * parsed.cost * parsed.blockSize * 2),
    });
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

export function needsRehash(encoded) {
  const parsed = parseEncodedHash(encoded);
  if (!parsed) return true;
  return (
    parsed.cost < COST || parsed.blockSize < BLOCK_SIZE || parsed.hash.length < KEY_LENGTH
  );
}

export const HASH_PARAMETERS = Object.freeze({
  algorithm: ALGORITHM,
  cost: COST,
  blockSize: BLOCK_SIZE,
  parallelism: PARALLELISM,
  keyLength: KEY_LENGTH,
  saltLength: SALT_LENGTH,
  minPasswordLength: MIN_PASSWORD_LENGTH,
});
