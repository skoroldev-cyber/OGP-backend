/**
 * The public route table, exercised end to end against the real Fastify app.
 *
 * `fastify.inject` runs the genuine plugin chain — error envelope, security headers, CORS,
 * schema validation, session auth — over an in-memory database. What is being proved here is
 * not that the handlers return 200: it is that the *refusals* are correct. An unauthenticated
 * read is refused, an undeclared payload key is dropped without failing its batch, an
 * ineligible share is a quiet 200 rather than an error the interface could dramatize, and the
 * family threshold cannot be reached by asking politely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/app.js';
import config from '../src/config/index.js';
import { createMemoryDb } from './helpers/memory-db.js';

/** A silent app over a fresh in-memory database. */
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
      // Phase 1B ships OFF (only `full_manuscript` is certified). The routing itself is still
      // worth proving, so the suite turns it on.
      flags: { ...config.flags, ageLayerEnabled: true },
    },
    logger: false,
    db,
  });

  return { app, db };
}

/** Create a session and return its bearer token. */
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

/* ------------------------------------------------------------------ */

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

  // §9.4: only the hash is stored. The raw bearer value must not be findable in the database.
  const stored = await db.collection('reading_sessions').findOne({});
  assert.ok(stored.tokenHash, 'the hash is stored');
  assert.ok(!JSON.stringify(stored).includes(sessionToken), 'the raw token was persisted');

  // §9.2.4: no name, no email, no address, no agent string.
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

  // The manifest is ordering, not content — the text arrives one unit at a time (§3.12).
  for (const unit of manifest.units) {
    assert.ok(!('blocks' in unit), `${unit.unitId} shipped its text in the manifest`);
    assert.ok(unit.unitId && typeof unit.sequenceIndex === 'number');
  }

  // The locked reading order (§3.5.2) must survive the round trip.
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

  // §9.7: releases never mutate, so the content route is infinitely cacheable.
  assert.match(response.headers['cache-control'] ?? '', /immutable/);

  // Editorial internals stay server-side (§9.3.1).
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

  // Fire-and-forget: the reader never learns that one item was malformed (§9.3.1).
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

  // §9.2.6, binding: "Failure returns a quiet 200 { eligible: false } — never an error the UI
  // could dramatize." A 4xx here would let the interface imply the reader did something wrong.
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

  // §9.2.10: creation is refused unless a validated convergence threshold was reached, or the
  // reader arrived through the S14 pathway after completing the Opening Arc.
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

  // The token no longer authenticates anything.
  const after = await app.inject({ method: 'GET', url: '/api/v1/sessions/current', headers: auth });
  assert.equal(after.statusCode, 401);

  // §9.5.3: severability. Nothing left behind may still point at the erased session.
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

  // §1.7.1: "Basic reading requires no account and no server-side per-user state; the entire
  // canonical reading path must be servable from CDN-cached immutable release content."
  // A required bearer token would break that, break the `immutable` cache header, and make the
  // read-only boot message's promise false.
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

  // The anti-scraping property of §9.3.1 never depended on the auth — the client cannot name a
  // layer either way. Without a session the server serves the default, which is the full
  // manuscript, not the foundation layer.
  const manifest = (
    await app.inject({ method: 'GET', url: '/api/v1/manuscript/manifest?arc=opening' })
  ).json();
  const target = manifest.units.find((unit) => unit.isReadingUnit);

  const attempt = await app.inject({
    method: 'GET',
    url: `/api/v1/manuscript/units/${target.unitId}?layer=foundation&contentLayer=foundation`,
  });

  assert.equal(attempt.statusCode, 200);
  // The ETag encodes the layer that was actually served. Asking for `foundation` in the query
  // string achieves nothing, because the server never reads it: the layer comes from the
  // session or from the default, and from nowhere else.
  assert.match(attempt.headers.etag ?? '', /^"full_manuscript-/, attempt.headers.etag);

  // And with a `foundation` session, the same unit serves that layer — proving the ETag really
  // does track the served rendering rather than being a constant.
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

  // §3.9's Motion setting is Full / Reduced / Off. `off` is a real destination, not a stronger
  // `reduced`: it stops ambient drift entirely. A server that rejects it 400s the one reader
  // who most needed the control.
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
