import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/app.js';
import config from '../src/config/index.js';
import { COLLECTIONS, creationStamps } from '../src/db/collections.js';
import { signJwt } from '../src/lib/jwt.js';
import {
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
  ADMIN_ACCESS_TOKEN_TYPE,
} from '../src/plugins/adminAuth.js';
import { parseCsv } from '../src/modules/admin/beta.js';
import {
  createAdminFeedbackService,
  FEEDBACK_EXPORT_COLUMNS,
} from '../src/modules/admin/feedback.js';
import { createAdminInvitationsService } from '../src/modules/admin/invitations.js';
import {
  createAdminTemplatesService,
  escapeHtml,
  renderCopy,
  substitute,
  TEMPLATE_PLACEHOLDERS,
} from '../src/modules/admin/templates.js';
import { createMemoryDb } from './helpers/memory-db.js';

async function makeApp() {
  const db = createMemoryDb();
  db.collection(COLLECTIONS.INVITATIONS).declareUnique(['code']);

  const app = await buildApp({
    config: { ...config, logLevel: 'silent', env: 'test' },
    logger: false,
    db,
  });

  return { app, db };
}

async function adminAuth(db, role = 'beta_coordinator') {
  const id = `01JADMIN0000000000000000${role.slice(0, 1).toUpperCase()}Z`;
  await db.collection(COLLECTIONS.ADMIN_USERS).insertOne({
    _id: id,
    email: `${role}@example.org`,
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

test('every substituted value is escaped for where it lands', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('Tom & "Jerry"'), 'Tom &amp; &quot;Jerry&quot;');
  assert.equal(escapeHtml("O'Neill"), 'O&#39;Neill');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');

  const hostile = '<img src=x onerror="alert(1)">';

  assert.equal(
    substitute('<p>{{displayName}}</p>', { displayName: hostile }, { html: true }),
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
  );
  assert.equal(substitute('{{displayName}},', { displayName: hostile }), `${hostile},`);

  assert.ok(
    !substitute('<a href="{{invitationUrl}}">link</a>', { invitationUrl: '" onclick="x' }, {
      html: true,
    }).includes('" onclick='),
  );

  const subject = substitute('Reading link for {{displayName}}', {
    displayName: 'Ada\r\nBcc: someone@example.org',
  }, { singleLine: true });
  assert.ok(!/[\r\n]/.test(subject), 'a newline survived into a subject header');
  assert.equal(subject, 'Reading link for Ada Bcc: someone@example.org');

  assert.equal(TEMPLATE_PLACEHOLDERS.length, 4);
  assert.equal(
    substitute('{{constructor}} {{__proto__}} {{cohortName}}', { cohortName: 'First cohort' }),
    '{{constructor}} {{__proto__}} First cohort',
  );

  const message = renderCopy(
    {
      subject: 'For {{displayName}}',
      bodyText: '{{displayName}}\n{{invitationUrl}}',
      bodyHtml: '<p>{{displayName}}</p><p>{{invitationUrl}}</p>',
    },
    { displayName: 'A & B <reader>', invitationUrl: 'https://example.org' },
  );
  assert.equal(message.subject, 'For A & B <reader>');
  assert.equal(message.text.split('\n')[0], 'A & B <reader>');
  assert.equal(message.html, '<p>A &amp; B &lt;reader&gt;</p><p>https://example.org</p>');

  assert.equal(renderCopy({ subject: 'x', bodyText: 'y', bodyHtml: null }, {}).html, null);
});

test('a prohibited term refuses the copy, names itself, and changes nothing', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());

  const auth = await adminAuth(db);

  const before = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
  });
  assert.equal(before.statusCode, 200, before.body);
  const stored = before.json().template;
  assert.deepEqual(stored.placeholders, [...TEMPLATE_PLACEHOLDERS]);

  const refused = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
    payload: {
      subject: 'Join us as a Founding Reader',
      bodyText: 'Your private reading link:\n{{invitationUrl}}',
    },
  });

  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal(refused.json().error.code, 'PROHIBITED_TERM');
  assert.match(refused.json().error.message, /"join us"/);

  const previewed = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/templates/beta_invitation/preview',
    headers: auth,
    payload: { subject: 'Join us as a Founding Reader', bodyText: '{{invitationUrl}}' },
  });
  assert.equal(previewed.statusCode, 422, previewed.body);
  assert.equal(previewed.json().error.code, 'PROHIBITED_TERM');

  const linkless = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
    payload: { subject: 'Your private reading link', bodyText: 'Read at your own pace.' },
  });
  assert.equal(linkless.statusCode, 422, linkless.body);
  assert.equal(linkless.json().error.code, 'MISSING_PLACEHOLDER');

  const unknown = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
    payload: { subject: 'Your link', bodyText: '{{invitationUrl}} {{firstName}}' },
  });
  assert.equal(unknown.statusCode, 422, unknown.body);
  assert.equal(unknown.json().error.code, 'UNKNOWN_PLACEHOLDER');

  const after = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
  });
  assert.deepEqual(after.json().template, stored, 'a refused edit changed the stored copy');

  const entries = await db.collection(COLLECTIONS.AUDIT_LOG).find({}).toArray();
  assert.equal(entries.length, 0, 'a refusal wrote to the audit trail; nothing changed');

  const accepted = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/templates/beta_invitation',
    headers: auth,
    payload: {
      subject: 'Your private reading link',
      bodyText: '{{displayName}},\n\n{{invitationUrl}}\n',
      bodyHtml: null,
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().template.version, stored.version + 1);
  assert.equal(accepted.json().template.bodyHtml, null, 'a plain-text-only message is a choice');

  const audited = await db.collection(COLLECTIONS.AUDIT_LOG).find({}).toArray();
  assert.equal(audited.length, 1);
  assert.equal(audited[0].action, 'email_template.update');

  const invented = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/templates/newsletter',
    headers: auth,
    payload: { subject: 'x', bodyText: '{{invitationUrl}}' },
  });
  assert.equal(invented.statusCode, 404, invented.body);

  const asEditor = await adminAuth(db, 'editor');
  const forbidden = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/templates',
    headers: asEditor,
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

function stubTransport(refuse = new Set()) {
  const outbox = [];
  return {
    outbox,
    async send(message) {
      if (refuse.has(message.to)) {
        const error = new Error('the relay accepted no recipient');
        error.code = 'MAIL_RECIPIENT_REJECTED';
        throw error;
      }
      outbox.push(message);
      return { delivered: true, transport: 'stub' };
    },
  };
}

test('a bulk send answers for every address, and one refusal does not spoil the batch', async () => {
  const db = createMemoryDb();
  db.collection(COLLECTIONS.INVITATIONS).declareUnique(['code']);

  await db.collection(COLLECTIONS.COHORTS).insertOne({
    _id: 'COHORT-1',
    name: 'Founding Readers — first cohort',
    type: 'individual',
    status: 'inviting',
    ...creationStamps(1),
  });

  await db.collection(COLLECTIONS.INVITATIONS).insertOne({
    _id: 'INV-HELD',
    cohortId: 'COHORT-1',
    code: 'already-holds-a-link-1',
    email: 'held@example.org',
    displayName: null,
    status: 'invited',
    sendCount: 1,
    lastError: null,
    ...creationStamps(1),
  });

  const mailer = stubTransport(new Set(['refused@example.org']));
  const templates = createAdminTemplatesService({ db, config });
  const service = createAdminInvitationsService({ db, config, mailer, templates });

  const outcome = await service.sendBulk(
    { _id: 'ADMIN-1' },
    {
      emails: [
        'reader.one@example.org',
        '  READER.ONE@example.org ',
        'refused@example.org',
        'not an address',
        'held@example.org',
      ],
      cohortId: 'COHORT-1',
      templateKey: 'beta_invitation',
    },
    { correlationId: 'CORR-1' },
  );

  assert.deepEqual(
    outcome.results.map((entry) => entry.email),
    ['reader.one@example.org', 'refused@example.org', 'not an address', 'held@example.org'],
  );

  for (const entry of outcome.results) {
    assert.deepEqual(Object.keys(entry).sort(), ['email', 'reason', 'status']);
    assert.ok(['sent', 'skipped', 'failed'].includes(entry.status));
    assert.ok(entry.reason === null || typeof entry.reason === 'string');
  }

  const byEmail = Object.fromEntries(outcome.results.map((entry) => [entry.email, entry]));
  assert.deepEqual(byEmail['reader.one@example.org'], {
    email: 'reader.one@example.org',
    status: 'sent',
    reason: null,
  });
  assert.equal(byEmail['refused@example.org'].status, 'failed');
  assert.equal(byEmail['refused@example.org'].reason, 'mail_recipient_rejected');
  assert.deepEqual(byEmail['not an address'], {
    email: 'not an address',
    status: 'failed',
    reason: 'invalid_address',
  });
  assert.deepEqual(byEmail['held@example.org'], {
    email: 'held@example.org',
    status: 'skipped',
    reason: 'already_invited',
  });

  assert.deepEqual(
    { sent: outcome.sent, skipped: outcome.skipped, failed: outcome.failed },
    { sent: 1, skipped: 1, failed: 2 },
  );

  assert.equal(mailer.outbox.length, 1);
  assert.equal(mailer.outbox[0].to, 'reader.one@example.org');
  assert.ok(!mailer.outbox[0].to.includes(','));
  assert.ok(!mailer.outbox[0].text.includes('held@example.org'));

  const sent = await db.collection(COLLECTIONS.INVITATIONS).findOne({ email: 'reader.one@example.org' });
  assert.equal(sent.status, 'invited');
  assert.ok(sent.readingLinkSentAt instanceof Date);
  assert.equal(sent.lastError, null);
  assert.ok(mailer.outbox[0].text.includes(sent.code), 'the message carries that record\'s own code');

  const failed = await db.collection(COLLECTIONS.INVITATIONS).findOne({ email: 'refused@example.org' });
  assert.equal(failed.status, 'new_interest', 'a refused send claimed the participant was invited');
  assert.equal(failed.lastError, 'mail_recipient_rejected');
  assert.equal(failed.sendCount, 0);

  const [entry] = await db.collection(COLLECTIONS.AUDIT_LOG).find({}).toArray();
  assert.equal(entry.action, 'invitation.send_bulk');
  assert.equal(entry.after.sent, 1);
  assert.equal(entry.after.addressed, 4);
  const trail = JSON.stringify(entry);
  for (const address of ['reader.one@example.org', 'refused@example.org', 'held@example.org']) {
    assert.ok(!trail.includes(address), `the audit entry carries "${address}"`);
  }
});

test('a coordinator\'s added line is held to the same rules as the message it rides on', async () => {
  const db = createMemoryDb();
  db.collection(COLLECTIONS.INVITATIONS).declareUnique(['code']);

  const mailer = stubTransport();
  const service = createAdminInvitationsService({
    db,
    config,
    mailer,
    templates: createAdminTemplatesService({ db, config }),
  });

  await assert.rejects(
    () =>
      service.sendBulk(
        { _id: 'ADMIN-1' },
        { emails: ['reader@example.org'], message: 'Join us — sign up today.' },
      ),
    (error) => error.code === 'PROHIBITED_TERM' && error.statusCode === 422,
  );

  assert.equal(mailer.outbox.length, 0, 'a refused batch still wrote to a mailbox');
  assert.equal(await db.collection(COLLECTIONS.INVITATIONS).countDocuments({}), 0);
  assert.equal(await db.collection(COLLECTIONS.AUDIT_LOG).countDocuments({}), 0);
});

test('the export survives quotes, commas and newlines because it is parsed back', async () => {
  const db = createMemoryDb();
  const service = createAdminFeedbackService({ db });

  const body = 'She said "stop, right there".\r\nThen: nothing, for a while.';
  const notes = 'Raised with the editor, twice; see "the Threshold note".';
  const displayName = 'Ada "Reader" Lovelace, PhD';

  await db.collection(COLLECTIONS.FEEDBACK).insertOne({
    _id: 'FB-AWKWARD',
    sessionId: 'SESSION-1',
    kind: 'passage',
    category: 'clarity',
    status: 'triaged',
    body,
    displayName,
    email: 'yes@example.org',
    contactConsent: true,
    passages: [
      { unitId: 'CU-A', excerpt: 'a line, with "both"\nand a break' },
      { unitId: 'CU-B', excerpt: 'plain' },
    ],
    releaseId: 'REL-TEST',
    readingFormat: 'immersive room',
    cohortId: 'COHORT-1',
    invitationId: null,
    adminNotes: notes,
    ...creationStamps(1, new Date('2026-01-02T03:04:05.000Z')),
  });

  const { csv, rows } = await service.exportFeedbackCsv({ _id: 'ADMIN-1' }, {});
  assert.equal(rows, 1);

  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 2, 'a newline inside a field became a new record');
  assert.deepEqual(parsed[0], [...FEEDBACK_EXPORT_COLUMNS]);
  assert.equal(parsed[1].length, FEEDBACK_EXPORT_COLUMNS.length, 'a comma inside a field split a column');

  const record = Object.fromEntries(FEEDBACK_EXPORT_COLUMNS.map((name, index) => [name, parsed[1][index]]));
  assert.equal(record.body, body, 'what the reader wrote did not survive the round trip');
  assert.equal(record.admin_notes, notes);
  assert.equal(record.display_name, displayName);
  assert.equal(record.email, 'yes@example.org');
  assert.equal(record.passage_unit_ids, 'CU-A CU-B');
  assert.equal(record.passage_excerpts, 'a line, with "both"\nand a break\nplain');
  assert.equal(record.submitted_at, '2026-01-02T03:04:05.000Z');
  assert.equal(record.id, 'FB-AWKWARD');

  assert.ok(csv.includes('"She said ""stop, right there"".'));
  assert.ok(!csv.includes('\\"'), 'a backslash escape reached the file');

  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.includes('SESSION-1'), 'the reading trail reached the export');
});
