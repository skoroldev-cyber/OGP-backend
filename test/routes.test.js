import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/app.js';
import config from '../src/config/index.js';
import { createMemoryDb } from './helpers/memory-db.js';

async function makeApp() {
  const db = createMemoryDb();
  db.collection('reading_sessions').declareUnique(['tokenHash']);
  db.collection('share_tokens').declareUnique(['token']);
  db.collection('invitations').declareUnique(['code']);
  db.collection('family_members').declareUnique(['email']);

  const app = await buildApp({
    config: {
      ...config,
      logLevel: 'silent',
      env: 'test',
      flags: { ...config.flags, ageLayerEnabled: true },
    },
    logger: false,
    db,
  });

  return { app, db };
}

async function newSession(app, body = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  const { sessionToken, session } = response.json();
  return { sessionToken, session, auth: { authorization: `Bearer ${sessionToken}` } };
}

test('healthz is liveness only and discloses no version', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });

  const body = response.body.toLowerCase();
  for (const leak of ['version', 'fastify', 'node', 'commit']) {
    assert.ok(!body.includes(leak), `/healthz leaked "${leak}"`);
  }
});

test('an unknown route is a clean 404, not a stack trace', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
  assert.ok(!/\n\s+at /.test(response.body), 'a stack trace escaped to the client');
  assert.ok(!response.body.includes('/src/'), 'a file path escaped to the client');
});

test('a session is created without any personal data and its token is returned once', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { sessionToken, session } = await newSession(app);

  assert.ok(sessionToken.length >= 40);
  assert.equal(session.ageBand ?? null, null, 'no band until the reader chooses one');

  const stored = await db.collection('reading_sessions').findOne({});
  assert.ok(stored.tokenHash, 'the hash is stored');
  assert.ok(!JSON.stringify(stored).includes(sessionToken), 'the raw token was persisted');

  for (const forbidden of ['email', 'name', 'ip', 'ipAddress', 'userAgent', 'birthdate', 'gender']) {
    assert.ok(!(forbidden in stored), `the session document carries "${forbidden}"`);
  }
});

test('reading routes refuse an absent or forged bearer token', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const noAuth = await app.inject({ method: 'GET', url: '/api/v1/sessions/current' });
  assert.equal(noAuth.statusCode, 400, 'a missing header fails schema validation');

  const forged = await app.inject({
    method: 'GET',
    url: '/api/v1/sessions/current',
    headers: { authorization: 'Bearer not-a-real-token-but-long-enough-to-look-like-one' },
  });
  assert.equal(forged.statusCode, 401);
  assert.equal(forged.json().error.code, 'SESSION_REQUIRED');
});

test('the age band is accepted, routed server-side, and never echoed into an event', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app, { ageBand: '8-12' });

  const current = await app.inject({ method: 'GET', url: '/api/v1/sessions/current', headers: auth });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().session.contentLayer, 'foundation', 'the founder routing, applied');

  await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: auth,
    payload: { events: [{ name: 'ReadingRoomEntered', occurredAt: new Date().toISOString() }] },
  });

  const stored = await db.collection('events').find({}).toArray();
  const serialised = JSON.stringify(stored);
  assert.ok(!serialised.includes('8-12'), 'the age band reached the event stream (§14.2)');
});

test('the gates are server-computed and cannot be set by the client', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const attempt = await app.inject({
    method: 'PATCH',
    url: '/api/v1/sessions/current',
    headers: auth,
    payload: { gates: { allow_sharing: true, allow_become_family: true } },
  });

  assert.equal(attempt.statusCode, 400, 'additionalProperties: false must reject the attempt');

  const current = await app.inject({ method: 'GET', url: '/api/v1/sessions/current', headers: auth });
  const { gates } = current.json().session;
  assert.equal(gates.allowSharing, false);
  assert.equal(gates.allowBecomeFamily, false);
});

test('the manifest serves the certified release and carries no manuscript text', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/manuscript/manifest?arc=opening',
    headers: auth,
  });

  assert.equal(response.statusCode, 200, response.body);
  const manifest = response.json();

  assert.ok(manifest.releaseId?.startsWith('REL-NONO-'), manifest.releaseId);
  assert.ok(Array.isArray(manifest.units) && manifest.units.length >= 12);

  for (const unit of manifest.units) {
    assert.ok(!('blocks' in unit), `${unit.unitId} shipped its text in the manifest`);
    assert.ok(unit.unitId && typeof unit.sequenceIndex === 'number');
  }

  const components = manifest.units.filter((unit) => !unit.parentUnitId);
  assert.equal(components.length, 12, 'the twelve protected components');
  assert.deepEqual(
    components.map((unit) => unit.componentIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    'the components arrive in the locked order',
  );
});

test('a unit is immutable and cacheable forever', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);
  const manifest = (
    await app.inject({
      method: 'GET',
      url: '/api/v1/manuscript/manifest?arc=opening',
      headers: auth,
    })
  ).json();

  const target = manifest.units.find((unit) => unit.componentIndex === 5 && unit.isReadingUnit);
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/manuscript/units/${target.unitId}`,
    headers: auth,
  });

  assert.equal(response.statusCode, 200, response.body);
  const { unit } = response.json();

  assert.ok(Array.isArray(unit.blocks) && unit.blocks.length > 0);
  assert.equal(unit.blocks[0].type, 'heading', 'a component opens with its authored heading');

  assert.match(response.headers['cache-control'] ?? '', /immutable/);

  for (const internal of ['emotional_metadata', 'resonance', 'scores', 'trauma_density']) {
    assert.ok(!(internal in unit), `the unit exposed "${internal}"`);
  }
});

test('an event batch rejects an undeclared payload key item-wise, without failing the batch', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);
  const occurredAt = new Date().toISOString();

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: auth,
    payload: {
      events: [
        { name: 'LandingStarted', occurredAt, payload: { deviceTier: 'high', reducedMotion: false } },
        { name: 'LandingStarted', occurredAt, payload: { ageRange: '8-12' } },
        { name: 'NotACanonicalEvent', occurredAt },
        { name: 'EarthRevealCompleted', occurredAt, payload: { mode: 'full', audioEnabled: false } },
      ],
    },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().accepted, 3, 'the unknown event name is dropped, the rest survive');

  const stored = await db.collection('events').find({}).toArray();
  assert.ok(!JSON.stringify(stored).includes('8-12'), 'a banned payload key was persisted');
  assert.ok(!stored.some((event) => event.name === 'NotACanonicalEvent'));
});

test('an oversized event batch is refused rather than silently truncated', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);
  const occurredAt = new Date().toISOString();

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: auth,
    payload: {
      events: Array.from({ length: 25 }, () => ({ name: 'LandingStarted', occurredAt })),
    },
  });

  assert.equal(response.statusCode, 400);
});

test('sharing is refused quietly, never as an error', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const eligibility = await app.inject({
    method: 'GET',
    url: '/api/v1/sharing/eligibility',
    headers: auth,
  });
  assert.equal(eligibility.statusCode, 200);
  assert.equal(eligibility.json().eligible, false, 'a fresh reader has not earned a share window');

  const created = await app.inject({ method: 'POST', url: '/api/v1/shares', headers: auth, payload: {} });

  assert.equal(created.statusCode, 200);
  assert.equal(created.json().eligible, false);
  assert.ok(!('shareUrl' in created.json()));
});

test('no reader-facing sharing response exposes an open count', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  for (const url of ['/api/v1/sharing/eligibility']) {
    const response = await app.inject({ method: 'GET', url, headers: auth });
    const body = response.body.toLowerCase();
    for (const counter of ['opencount', 'opens', 'sharecount', 'views']) {
      assert.ok(!body.includes(counter), `${url} exposed "${counter}" — a prohibited mechanic`);
    }
  }
});

test('the family threshold cannot be reached by asking', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/family',
    headers: auth,
    payload: {
      email: 'reader@example.org',
      communicationPreference: 'none',
    },
  });

  assert.ok(
    response.statusCode === 403 || response.statusCode === 409,
    `expected a refusal, got ${response.statusCode}: ${response.body}`,
  );

  assert.equal(await db.collection('family_members').countDocuments({}), 0);
});

test('every response carries the security headers and none carries a server banner', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/healthz' });

  assert.ok(!response.headers['x-powered-by'], 'x-powered-by must be suppressed');
  assert.ok(response.headers['x-content-type-options'], 'nosniff is expected');
  assert.ok(!response.headers.server?.toLowerCase().includes('fastify'));
});

test('the error envelope is uniform and never leaks internals', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { ageBand: 'not-a-band' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.ok(body.error, 'errors are always enveloped');
  assert.match(body.error.code, /^[A-Z_]+$/, `code was "${body.error.code}"`);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(!response.body.includes('/src/'), 'a file path escaped to the client');
});

test('a deleted session is gone and its references are severed', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth, session } = await newSession(app);

  await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: auth,
    payload: { events: [{ name: 'LandingStarted', occurredAt: new Date().toISOString() }] },
  });

  const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/sessions/current', headers: auth });
  assert.equal(deleted.statusCode, 204);

  assert.equal(await db.collection('reading_sessions').countDocuments({}), 0);

  const after = await app.inject({ method: 'GET', url: '/api/v1/sessions/current', headers: auth });
  assert.equal(after.statusCode, 401);

  for (const collection of [
    'donations',
    'orders',
    'family_members',
    'questionnaire_responses',
    'feedback',
  ]) {
    const survivors = await db.collection(collection).find({ sessionId: session.id }).toArray();
    assert.equal(survivors.length, 0, `${collection} still references the erased session`);
  }
});

test('the manuscript is readable without a session token', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const manifest = await app.inject({ method: 'GET', url: '/api/v1/manuscript/manifest?arc=opening' });
  assert.equal(manifest.statusCode, 200, manifest.body);
  assert.ok(manifest.json().units.length >= 12);

  const target = manifest.json().units.find((unit) => unit.isReadingUnit);
  const unit = await app.inject({ method: 'GET', url: `/api/v1/manuscript/units/${target.unitId}` });
  assert.equal(unit.statusCode, 200, unit.body);
  assert.ok(Array.isArray(unit.json().unit.blocks));
  assert.match(unit.headers['cache-control'] ?? '', /immutable/);
});

test('an anonymous caller cannot reach a youth rendering by omitting the header', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const manifest = (
    await app.inject({ method: 'GET', url: '/api/v1/manuscript/manifest?arc=opening' })
  ).json();
  const target = manifest.units.find((unit) => unit.isReadingUnit);

  const attempt = await app.inject({
    method: 'GET',
    url: `/api/v1/manuscript/units/${target.unitId}?layer=foundation&contentLayer=foundation`,
  });

  assert.equal(attempt.statusCode, 200);
  assert.match(attempt.headers.etag ?? '', /^"full_manuscript-/, attempt.headers.etag);

  const { auth } = await newSession(app, { ageBand: '8-12' });
  const withSession = await app.inject({
    method: 'GET',
    url: `/api/v1/manuscript/units/${target.unitId}`,
    headers: auth,
  });
  assert.match(withSession.headers.etag ?? '', /^"foundation-/, withSession.headers.etag);
});

test('the motion preference vocabulary matches what a reader can choose', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  for (const motionPreference of ['full', 'reduced', 'off']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { motionPreference },
    });
    assert.equal(response.statusCode, 201, `motionPreference "${motionPreference}": ${response.body}`);
  }

  const nonsense = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { motionPreference: 'sideways' },
  });
  assert.equal(nonsense.statusCode, 400, 'the enum is still closed');
});
