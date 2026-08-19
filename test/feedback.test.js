/**
 * Free-form reader feedback — capture, consent, and the review surface.
 *
 * The properties under test are the ones that would be expensive to discover late:
 *
 *  - The body is required and identity is not. A reader may write anonymously.
 *  - An email address exists on the record only when the reader consented to contact. Not
 *    "is hidden unless" — is *absent* unless, so no later projection can leak it.
 *  - A passage anchor is resolved against the governing release, and a mark naming content
 *    that no longer exists is dropped quietly rather than costing the reader their words.
 *  - The record carries no age band, no birthdate, no location, no network identity.
 *  - The founder's summary is an aggregate and has no shape in which a reader appears.
 *  - The CSV export is RFC 4180, because reader feedback contains commas, quotes and
 *    newlines constantly and a naive join would corrupt the file on the first submission.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/app.js';
import config from '../src/config/index.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../src/config/constants.js';
import { COLLECTIONS, creationStamps } from '../src/db/collections.js';
import { signJwt } from '../src/lib/jwt.js';
import {
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
  ADMIN_ACCESS_TOKEN_TYPE,
} from '../src/plugins/adminAuth.js';
import {
  createAdminFeedbackService,
  csvField,
  toCsv,
  FEEDBACK_EXPORT_COLUMNS,
} from '../src/modules/admin/feedback.js';
import { createMemoryDb } from './helpers/memory-db.js';

/** A silent app over a fresh in-memory database. */
async function makeApp() {
  const db = createMemoryDb();
  db.collection('reading_sessions').declareUnique(['tokenHash']);

  const app = await buildApp({
    config: { ...config, logLevel: 'silent', env: 'test' },
    logger: false,
    db,
  });

  return { app, db };
}

/** Create a session and return its bearer header. */
async function newSession(app) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: {} });
  assert.equal(response.statusCode, 201, response.body);
  const { sessionToken, session } = response.json();
  return { session, auth: { authorization: `Bearer ${sessionToken}` } };
}

/**
 * An enrolled administrator and a bearer header for them. The login route proves password
 * and TOTP; this mints the token that route would have issued, so the *authorisation* rules
 * can be exercised without rebuilding the credential ceremony in every test.
 */
async function adminAuth(db, role = 'founder') {
  const id = '01JADMIN00000000000000000A';
  await db.collection(COLLECTIONS.ADMIN_USERS).insertOne({
    _id: id,
    email: 'ops@example.org',
    role,
    active: true,
    mfa: { enabled: true, confirmedAt: new Date() },
    ...creationStamps(1),
  });
  const { token } = signJwt(
    { sub: id, role, typ: ADMIN_ACCESS_TOKEN_TYPE },
    {
      secret: config.secrets.adminJwt,
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
      expiresInSec: 600,
    },
  );
  return { authorization: `Bearer ${token}` };
}

/** A real unit identifier from the governing release. */
async function anyUnitId(app) {
  const manifest = await app.inject({ method: 'GET', url: '/api/v1/manuscript/manifest?arc=opening' });
  assert.equal(manifest.statusCode, 200, manifest.body);
  const unit = manifest.json().units.find((entry) => entry.isReadingUnit);
  return unit.unitId;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

test('feedback requires something written, and nothing else', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { category: 'clarity' },
  });
  assert.equal(missing.statusCode, 400, 'a submission with no body is refused');
  assert.equal(missing.json().error.code, 'VALIDATION_FAILED');

  const blank = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { body: '    ' },
  });
  assert.equal(blank.statusCode, 422, 'whitespace is not a submission');
  assert.equal(blank.json().error.code, 'FEEDBACK_EMPTY');

  // Name and email are optional; the body alone is a complete submission.
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { body: 'The Foreword landed. I had to stop and sit with it.' },
  });
  assert.equal(anonymous.statusCode, 201, anonymous.body);
  assert.equal(anonymous.json().received, true);
  assert.equal(anonymous.json().feedback.kind, 'general');
  assert.equal(anonymous.json().feedback.category, 'other', 'no category means "other", not a guess');

  const stored = await db.collection(COLLECTIONS.FEEDBACK).findOne({});
  assert.equal(stored.displayName, null);
  assert.equal(stored.email, null);
  assert.equal(stored.status, 'new');
});

test('an email is stored only when the reader consented to be contacted', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  const withheld = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: {
      body: 'The pacing in the Introduction felt right to me.',
      displayName: 'A reader',
      email: 'reader@example.org',
      contactConsent: false,
    },
  });
  assert.equal(withheld.statusCode, 201, withheld.body);

  const documents = await db.collection(COLLECTIONS.FEEDBACK).find({}).toArray();
  assert.equal(documents.length, 1);
  assert.equal(documents[0].email, null, 'an address arrived without consent and was stored anyway');
  assert.equal(documents[0].contactConsent, false);
  assert.ok(
    !JSON.stringify(documents[0]).includes('reader@example.org'),
    'the address survived somewhere in the document',
  );

  // The confirmation the reader sees does not echo an address the platform declined to keep.
  assert.ok(!withheld.body.includes('reader@example.org'));

  const consented = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: {
      body: 'Happy to talk about the witness sections if that is useful.',
      email: 'reader@example.org',
      contactConsent: true,
    },
  });
  assert.equal(consented.statusCode, 201, consented.body);

  const kept = await db
    .collection(COLLECTIONS.FEEDBACK)
    .findOne({ contactConsent: true });
  assert.equal(kept.email, 'reader@example.org', 'consent given, address kept');
});

test('a marked passage is anchored to the release, and an unknown mark is dropped quietly', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);
  const unitId = await anyUnitId(app);

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: {
      category: 'emotional_weight',
      body: 'This line stayed with me.',
      passages: [
        { unitId, excerpt: 'You are not entering a system.', charStart: 400, charEnd: 120 },
        { unitId: 'CU-DOES-NOT-EXIST', excerpt: 'from an older copy', charStart: 0, charEnd: 9 },
      ],
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  const { feedback } = response.json();

  assert.equal(feedback.kind, 'passage', 'the kind follows the marks, and is not client-declared');
  assert.equal(feedback.passages.length, 1, 'the stale mark was dropped, the submission survived');
  assert.equal(feedback.passages[0].unitId, unitId);
  // Inverted offsets are normalised rather than refused — they still identify the passage.
  assert.equal(feedback.passages[0].charStart, 120);
  assert.equal(feedback.passages[0].charEnd, 400);

  const stored = await db.collection(COLLECTIONS.FEEDBACK).findOne({});
  assert.ok(stored.releaseId, 'the release is stamped: character offsets mean nothing without it');
  assert.equal(stored.readingFormat, 'immersive room');
});

test('the feedback record carries nothing that could profile the reader', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  // A client that tries to attach profiling data is refused at the schema, not filtered
  // afterwards — `additionalProperties: false` is the mechanism (§9.5).
  const attempt = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { body: 'Something to say.', ageBand: '33+', location: 'Berlin' },
  });
  assert.equal(attempt.statusCode, 400, 'profiling fields must be refused, not ignored');

  await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { body: 'Something to say.' },
  });

  const stored = await db.collection(COLLECTIONS.FEEDBACK).findOne({});
  for (const banned of [
    'ageBand',
    'ageRange',
    'contentLayer',
    'birthdate',
    'gender',
    'ip',
    'ipAddress',
    'userAgent',
    'location',
    'deviceId',
  ]) {
    assert.ok(!(banned in stored), `the feedback document carries "${banned}"`);
  }
});

test('a reader can see what they sent, and no triage state', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);

  await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { category: 'accessibility', body: 'The contrast was hard for me at first.' },
  });

  const mine = await app.inject({ method: 'GET', url: '/api/v1/feedback/mine', headers: auth });
  assert.equal(mine.statusCode, 200, mine.body);

  const { feedback } = mine.json();
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].body, 'The contrast was hard for me at first.');
  assert.equal(feedback[0].category, 'accessibility');

  // Triage is staff workflow. "Archived" is not something a person should read about their
  // own words, so the reader-facing shape has nowhere to put it.
  assert.ok(!('status' in feedback[0]), 'triage state reached the reader');
  assert.ok(!('adminNotes' in feedback[0]), 'reviewer notes reached the reader');

  // Another session sees none of it.
  const { auth: otherAuth } = await newSession(app);
  const others = await app.inject({
    method: 'GET',
    url: '/api/v1/feedback/mine',
    headers: otherAuth,
  });
  assert.deepEqual(others.json().feedback, []);
});

/* ------------------------------------------------------------------ */
/* Review surface                                                      */
/* ------------------------------------------------------------------ */

/** Seed the feedback collection directly; the admin service is exercised without HTTP. */
function seedFeedback(db, entries) {
  const collection = db.collection(COLLECTIONS.FEEDBACK);
  return Promise.all(
    entries.map((entry, index) =>
      collection.insertOne({
        _id: `FB${index}`,
        sessionId: `SESSION${index}`,
        kind: entry.passages?.length ? 'passage' : 'general',
        category: entry.category ?? 'other',
        body: entry.body ?? 'text',
        displayName: entry.displayName ?? null,
        email: entry.email ?? null,
        contactConsent: entry.contactConsent === true,
        passages: entry.passages ?? [],
        releaseId: 'REL-TEST',
        readingFormat: 'immersive room',
        invitationId: null,
        cohortId: entry.cohortId ?? null,
        status: entry.status ?? 'new',
        adminNotes: null,
        ...creationStamps(1, new Date(1_700_000_000_000 + index * 1000)),
      }),
    ),
  );
}

test('the summary is an aggregate, with a stable axis and no reader in it', async () => {
  const db = createMemoryDb();
  const service = createAdminFeedbackService({ db });

  await seedFeedback(db, [
    { category: 'clarity', passages: [{ unitId: 'CU-A' }] },
    { category: 'clarity', status: 'triaged', passages: [{ unitId: 'CU-A' }, { unitId: 'CU-B' }] },
    { category: 'pacing', status: 'actioned' },
  ]);

  const summary = await service.summariseFeedback({});

  assert.equal(summary.total, 3);

  // Every category and every status is present, including the empty ones: a founder reading
  // this needs the same axis every time, not one that changes shape with the data.
  assert.equal(summary.byCategory.length, FEEDBACK_CATEGORIES.length);
  assert.equal(summary.byStatus.length, FEEDBACK_STATUSES.length);

  const category = Object.fromEntries(summary.byCategory.map((row) => [row.category, row.count]));
  assert.equal(category.clarity, 2);
  assert.equal(category.pacing, 1);
  assert.equal(category.honesty, 0);

  const status = Object.fromEntries(summary.byStatus.map((row) => [row.status, row.count]));
  assert.deepEqual(status, { new: 1, triaged: 1, actioned: 1, archived: 0 });

  // One submission counts once against each unit it marked, and the busiest unit sorts first.
  assert.deepEqual(summary.byUnit, [
    { unitId: 'CU-A', count: 2 },
    { unitId: 'CU-B', count: 1 },
  ]);

  // §10.2: aggregate only. Nothing here is keyed by a person.
  const serialised = JSON.stringify(summary);
  assert.ok(!serialised.includes('SESSION'), 'a session identifier reached the summary');
  assert.ok(!serialised.includes('sessionId'), 'the summary is grouped by reader somewhere');
});

test('the queue filters by unit, category, state and free text', async () => {
  const db = createMemoryDb();
  const service = createAdminFeedbackService({ db });

  await seedFeedback(db, [
    { category: 'clarity', body: 'The Threshold section confused me.', passages: [{ unitId: 'CU-A' }] },
    { category: 'factual_concern', body: 'The Flint dates look wrong.', status: 'triaged' },
    { category: 'clarity', body: 'Clear throughout.', cohortId: 'COHORT-1' },
  ]);

  assert.equal((await service.listFeedback({ category: 'clarity' })).total, 2);
  assert.equal((await service.listFeedback({ status: 'triaged' })).total, 1);
  assert.equal((await service.listFeedback({ unitId: 'CU-A' })).total, 1);
  assert.equal((await service.listFeedback({ cohortId: 'COHORT-1' })).total, 1);
  assert.equal((await service.listFeedback({ q: 'flint' })).total, 1, 'search is case-insensitive');

  // A search string is text, not a pattern: a stray metacharacter must not become an operator.
  assert.equal((await service.listFeedback({ q: 'wrong.' })).total, 1);
  assert.equal((await service.listFeedback({ q: 'wrong!' })).total, 0);

  // No projection on this surface carries the reading trail.
  const listing = await service.listFeedback({});
  assert.ok(!JSON.stringify(listing).includes('sessionId'));

  const paged = await service.listFeedback({ limit: 2, page: 2 });
  assert.equal(paged.page, 2);
  assert.equal(paged.feedback.length, 1);
  assert.equal(paged.total, 3, 'the total counts the filtered set, not the page');
});

test('triage records who changed what, and cannot edit what the reader wrote', async () => {
  const db = createMemoryDb();
  const service = createAdminFeedbackService({ db });

  await seedFeedback(db, [{ category: 'honesty', body: 'This is what I actually said.' }]);

  const { feedback } = await service.updateFeedback(
    { _id: 'ADMIN-1' },
    'FB0',
    { status: 'triaged', adminNotes: 'Raised with the editor.' },
    { correlationId: 'CORR-1' },
  );

  assert.equal(feedback.status, 'triaged');
  assert.equal(feedback.adminNotes, 'Raised with the editor.');
  assert.equal(feedback.body, 'This is what I actually said.', 'the reader\'s words are untouched');

  const entries = await db.collection(COLLECTIONS.AUDIT_LOG).find({}).toArray();
  assert.equal(entries.length, 1, 'every admin mutation writes to the audit trail');
  assert.equal(entries[0].action, 'feedback.update');
  assert.equal(entries[0].actorId, 'ADMIN-1');
  assert.equal(entries[0].targetId, 'FB0');
  assert.equal(entries[0].before.status, 'new');
  assert.equal(entries[0].after.status, 'triaged');

  // The trail records the decision, not the evidence: a reader's text is not copied into a
  // second, longer-lived collection by the act of triaging it.
  assert.ok(!JSON.stringify(entries[0]).includes('This is what I actually said.'));

  await assert.rejects(
    () => service.updateFeedback({ _id: 'ADMIN-1' }, 'NOPE', { status: 'archived' }),
    /does not exist/,
  );
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

test('CSV fields are escaped per RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(null), '');
  assert.equal(csvField('a,b'), '"a,b"', 'a comma forces quoting');
  assert.equal(csvField('she said "no"'), '"she said ""no"""', 'quotes are doubled, not escaped');
  assert.equal(csvField('line one\nline two'), '"line one\nline two"', 'a newline forces quoting');
  assert.equal(csvField('carriage\r'), '"carriage\r"');

  assert.equal(
    toCsv([
      ['a', 'b'],
      ['1,1', 'say "hi"\nplease'],
    ]),
    'a,b\r\n"1,1","say ""hi""\nplease"\r\n',
    'records are CRLF-separated and the last one is terminated',
  );
});

test('the export carries contact details only where consent was given', async () => {
  const db = createMemoryDb();
  const service = createAdminFeedbackService({ db });

  await seedFeedback(db, [
    {
      category: 'clarity',
      body: 'Comma, quote " and\nnewline all at once.',
      displayName: 'Consenting Reader',
      email: 'yes@example.org',
      contactConsent: true,
    },
    {
      category: 'clarity',
      body: 'No contact wanted.',
      displayName: 'Withheld Reader',
      contactConsent: false,
    },
  ]);

  const { csv, rows } = await service.exportFeedbackCsv({ _id: 'ADMIN-1' }, {}, {});
  assert.equal(rows, 2);

  const [header] = csv.split('\r\n');
  assert.equal(header, FEEDBACK_EXPORT_COLUMNS.join(','), 'the documented columns, in order');

  assert.ok(csv.includes('yes@example.org'));
  assert.ok(csv.includes('Consenting Reader'));
  // A CSV leaves the platform. The name of a reader who declined contact does not go with it.
  assert.ok(!csv.includes('Withheld Reader'), 'a non-consenting reader was named in the export');

  // The awkward body survives quoting intact.
  assert.ok(csv.includes('"Comma, quote "" and\nnewline all at once."'));

  const entries = await db.collection(COLLECTIONS.AUDIT_LOG).find({}).toArray();
  assert.equal(entries[0].action, 'feedback.export');
  assert.equal(entries[0].after.rows, 2, 'an export off the platform is an audited act');
});

test('the review routes are admin-only, and the export leaves as CSV rather than JSON', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const { auth } = await newSession(app);
  await app.inject({
    method: 'POST',
    url: '/api/v1/feedback',
    headers: auth,
    payload: { category: 'clarity', body: 'One line, with a comma, and a "quote".' },
  });

  // A reader's session token opens nothing on the review surface.
  const asReader = await app.inject({ method: 'GET', url: '/api/v1/admin/feedback', headers: auth });
  assert.equal(asReader.statusCode, 401);

  const admin = await adminAuth(db);

  const listing = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/feedback?status=new&category=clarity&page=1',
    headers: admin,
  });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(listing.json().total, 1);
  const [record] = listing.json().feedback;
  assert.ok(!('sessionId' in record), 'the reading trail is reachable from the review queue');

  const summary = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/feedback/summary',
    headers: admin,
  });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().total, 1);

  const triaged = await app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/feedback/${record.id}`,
    headers: admin,
    payload: { status: 'triaged', adminNotes: 'Noted.' },
  });
  assert.equal(triaged.statusCode, 200, triaged.body);
  assert.equal(triaged.json().feedback.status, 'triaged');

  // The queue cannot rewrite the evidence.
  const rewrite = await app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/feedback/${record.id}`,
    headers: admin,
    payload: { body: 'Something the reader did not say.' },
  });
  assert.equal(rewrite.statusCode, 400, 'a body edit must not be an accepted field');

  const exported = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/feedback/export.csv',
    headers: admin,
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(exported.headers['content-type'], /^text\/csv/);
  assert.match(exported.headers['content-disposition'] ?? '', /filename="feedback\.csv"/);

  // The whole point of sending a Buffer: a JSON serialiser would have wrapped and escaped
  // the document, and every quoted field would arrive doubled again.
  assert.ok(exported.body.startsWith('id,submitted_at,'), exported.body.slice(0, 60));
  assert.ok(exported.body.includes('"One line, with a comma, and a ""quote""."'));
});
