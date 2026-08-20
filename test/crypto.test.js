import test from 'node:test';
import assert from 'node:assert/strict';

import {
  constantTimeEqual,
  mintSessionToken,
  hashSessionToken,
  bearerFromHeader,
  signValue,
  verifySignedValue,
  signReceiptToken,
  verifyReceiptToken,
} from '../src/lib/tokens.js';
import { hashPassword, verifyPassword, checkPasswordStrength, needsRehash } from '../src/lib/hash.js';
import { signJwt, verifyJwt, decodeJwt } from '../src/lib/jwt.js';
import { generateTotpSecret, generateTotp, verifyTotp, buildOtpAuthUri } from '../src/lib/totp.js';

const SECRET = 'test-secret-at-least-thirty-two-bytes-long-value';
const OTHER_SECRET = 'a-completely-different-secret-of-similar-length!!';

test('a session token is high-entropy, URL-safe, and never stored raw', () => {
  const token = mintSessionToken();

  assert.ok(token.length >= 40, `token too short: ${token.length}`);
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'token must be URL-safe');

  const stored = hashSessionToken(token);
  assert.notEqual(stored, token);
  assert.match(stored, /^[0-9a-f]{64}$/, 'the stored form is a hex SHA-256 digest');
  assert.equal(hashSessionToken(token), stored, 'hashing is deterministic');
});

test('two mints never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(mintSessionToken());
  assert.equal(seen.size, 500);
});

test('bearerFromHeader accepts only a well-formed Bearer header', () => {
  assert.equal(bearerFromHeader('Bearer abc123'), 'abc123');
  assert.equal(bearerFromHeader('  Bearer abc123  '), 'abc123');
  assert.equal(bearerFromHeader('abc123'), null);
  assert.equal(bearerFromHeader('Basic abc123'), null);
  assert.equal(bearerFromHeader('Bearer '), null);
  assert.equal(bearerFromHeader(''), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(null), null);
});

test('constantTimeEqual is correct on equal, unequal and mismatched lengths', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, 'abc'), false);
  assert.equal(constantTimeEqual('abc', undefined), false);
});

test('a signed value round-trips and refuses a tampered payload', () => {
  const token = signValue({ sub: 'order-42' }, { secret: SECRET });

  const ok = verifySignedValue(token, { secrets: [SECRET] });
  assert.equal(ok.valid, true);
  assert.equal(ok.claims.sub, 'order-42');

  const [version, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.sub = 'order-43';
  const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const forged = `${version}.${forgedPayload}.${signature}`;

  assert.equal(verifySignedValue(forged, { secrets: [SECRET] }).valid, false);

  assert.equal(verifySignedValue(token, { secrets: [OTHER_SECRET] }).valid, false);

  for (const bad of ['', 'nonsense', 'v1.only-two', null, undefined]) {
    assert.equal(verifySignedValue(bad, { secrets: [SECRET] }).valid, false, `bad token: ${bad}`);
  }
});

test('key rotation verifies under the retiring secret and reports which key matched', () => {
  const OLD = 'the-previous-secret-thirty-two-bytes-minimum!';
  const NEW = 'the-current-secret-thirty-two-bytes-minimum!!';

  const signedWithOld = signValue({ sub: 'session-abc' }, { secret: OLD });

  const during = verifySignedValue(signedWithOld, { secrets: [NEW, OLD] });
  assert.equal(during.valid, true);
  assert.equal(during.secretIndex, 1, 'the retiring key is index 1 — useful for rotation metrics');

  assert.equal(verifySignedValue(signedWithOld, { secrets: [NEW] }).valid, false);
});

test('a signed value expires', () => {
  const token = signValue({ sub: 'x' }, { secret: SECRET, ttlMs: 1000 });
  assert.equal(verifySignedValue(token, { secrets: [SECRET] }).valid, true);

  const later = Date.now() + 5000;
  const expired = verifySignedValue(token, { secrets: [SECRET], now: later });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'expired');
});

test('a receipt token is bound to its receipt number', () => {
  const token = signReceiptToken({ receiptNumber: 'OGP-D-000123' });

  assert.equal(verifyReceiptToken(token, 'OGP-D-000123').valid, true);

  assert.equal(verifyReceiptToken(token, 'OGP-D-000124').valid, false);

  const expired = signReceiptToken({ receiptNumber: 'OGP-D-000123', ttlMs: -1 });
  assert.equal(verifyReceiptToken(expired, 'OGP-D-000123').valid, false);
});

test('a password hash round-trips and rejects the wrong password', async () => {
  const encoded = await hashPassword('Correct-Horse-Battery-Staple-9');

  assert.ok(encoded.startsWith('scrypt$'), `unexpected encoding: ${encoded.slice(0, 20)}`);
  assert.ok(!encoded.includes('Correct-Horse'), 'the plaintext must not appear in the encoding');

  assert.equal(await verifyPassword('Correct-Horse-Battery-Staple-9', encoded), true);
  assert.equal(await verifyPassword('correct-horse-battery-staple-9', encoded), false);
  assert.equal(await verifyPassword('', encoded), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword('Correct-Horse-Battery-Staple-9');
  const b = await hashPassword('Correct-Horse-Battery-Staple-9');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('Correct-Horse-Battery-Staple-9', a), true);
  assert.equal(await verifyPassword('Correct-Horse-Battery-Staple-9', b), true);
});

test('verifyPassword survives a malformed stored hash instead of throwing', async () => {
  for (const bad of ['', 'not-an-encoding', 'scrypt$only$three$parts', null, undefined]) {
    assert.equal(await verifyPassword('anything', bad), false, `bad encoding: ${bad}`);
  }
});

test('password strength is enforced before an admin account can exist', () => {
  assert.equal(checkPasswordStrength('short').ok, false);
  assert.equal(checkPasswordStrength('alllowercasenodigits').ok, false, 'needs character variety');
  assert.equal(checkPasswordStrength('Correct-Horse-Battery-Staple-9').ok, true);
  assert.equal(checkPasswordStrength(null).ok, false);
});

test('needsRehash reports on parameter drift, not on a fresh hash', async () => {
  const encoded = await hashPassword('Correct-Horse-Battery-Staple-9');
  assert.equal(needsRehash(encoded), false);
  assert.equal(needsRehash('scrypt$1$1$1$00$00'), true);
});

test('a JWT round-trips and carries iat, exp and jti', () => {
  const { token } = signJwt({ sub: 'admin-1', role: 'editor' }, { secret: SECRET, expiresInSec: 900 });
  const claims = verifyJwt(token, { secret: SECRET });

  assert.equal(claims.sub, 'admin-1');
  assert.equal(claims.role, 'editor');
  assert.ok(claims.iat, 'iat is required');
  assert.ok(claims.exp > claims.iat, 'exp must be in the future');
  assert.ok(claims.jti, 'jti is required so one token can be revoked individually');
});

test('a JWT with a tampered payload does not verify', () => {
  const { token } = signJwt({ sub: 'admin-1', role: 'reviewer' }, { secret: SECRET, expiresInSec: 900 });
  const [header, payload, signature] = token.split('.');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.role = 'founder';
  const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

  assert.throws(() => verifyJwt(forged, { secret: SECRET }));
  assert.equal(decodeJwt(forged).role, 'founder');
});

test('a JWT signed with a different secret does not verify', () => {
  const { token } = signJwt({ sub: 'admin-1' }, { secret: OTHER_SECRET, expiresInSec: 900 });
  assert.throws(() => verifyJwt(token, { secret: SECRET }));
});

test('an expired JWT does not verify', () => {
  const { token } = signJwt({ sub: 'admin-1' }, { secret: SECRET, expiresInSec: 900 });

  assert.equal(verifyJwt(token, { secret: SECRET }).sub, 'admin-1', 'valid while fresh');
  assert.throws(
    () => verifyJwt(token, { secret: SECRET, now: Date.now() + 3_600_000 }),
    /expire/i,
  );
});

test('a JWT is refused before its not-before time', () => {
  const { token } = signJwt({ sub: 'admin-1' }, { secret: SECRET, expiresInSec: 900 });
  assert.throws(() => verifyJwt(token, { secret: SECRET, now: Date.now() - 3_600_000 }));
});

test('the "none" algorithm is refused', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: 'admin-1', role: 'founder', exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString('base64url');

  assert.throws(() => verifyJwt(`${header}.${payload}.`, { secret: SECRET }));
});

test('a malformed JWT is refused rather than throwing something unexpected', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-jwt']) {
    assert.throws(() => verifyJwt(bad, { secret: SECRET }), undefined, `bad token: ${bad}`);
  }
  assert.equal(decodeJwt('not-a-jwt'), null);
});

test('a generated TOTP verifies and a wrong one does not', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]+$/, 'base32, no padding');

  const code = generateTotp(secret);
  assert.match(code, /^\d{6}$/);

  assert.equal(verifyTotp(secret, code).valid, true);
  assert.equal(verifyTotp(secret, 'abcdef').valid, false);
  assert.equal(verifyTotp(secret, '').valid, false);
  assert.equal(verifyTotp(secret, null).valid, false);
});

test('a TOTP from a different secret does not verify', () => {
  const code = generateTotp(generateTotpSecret());
  const other = generateTotpSecret();
  const result = verifyTotp(other, code);
  assert.equal(result.valid, false);
});

test('TOTP accepts the adjacent window but not a distant one', () => {
  const secret = generateTotpSecret();
  const now = Date.now();

  const previous = generateTotp(secret, { timestamp: now - 30_000 });
  const next = generateTotp(secret, { timestamp: now + 30_000 });
  const distant = generateTotp(secret, { timestamp: now + 600_000 });

  assert.equal(verifyTotp(secret, previous, { timestamp: now }).valid, true);
  assert.equal(verifyTotp(secret, previous, { timestamp: now }).delta, -1);
  assert.equal(verifyTotp(secret, next, { timestamp: now }).valid, true);
  assert.equal(verifyTotp(secret, next, { timestamp: now }).delta, 1);
  assert.equal(verifyTotp(secret, distant, { timestamp: now }).valid, false);
});

test('the otpauth URI names the issuer and the account', () => {
  const uri = buildOtpAuthUri({
    secret: generateTotpSecret(),
    accountName: 'one@oneglobalpeople.org',
  });
  assert.ok(uri.startsWith('otpauth://totp/'), uri.slice(0, 40));
  assert.match(uri, /issuer=One(%20|\+)Global(%20|\+)People/);
  assert.match(uri, /secret=[A-Z2-7]+/);
});
