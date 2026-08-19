/**
 * The anti-profiling rules, as executable tests.
 *
 * §9.5 makes a public promise to readers: "Your age range is used only to adjust reading depth,
 * language, and emotional intensity. It is not used to profile you." A promise like that is
 * only worth what the schema enforces, so this asserts the schema.
 *
 * If one of these fails, the fix is never to relax the test. It is to remove the field.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROHIBITED_FIELDS } from '../src/config/constants.js';
import {
  COLLECTION_VALIDATORS,
  declaredFieldNames,
  assertNoProhibitedFields,
} from '../src/db/validators.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('PROHIBITED_FIELDS covers every category the corpus names', () => {
  // §14.4.3: no gender question, no exact birthdate, no political or psychological profiling.
  // §9.5.2: no IP retention. §9.2.5: no user-agent string, no geolocation, no referrer.
  for (const field of [
    'birthdate',
    'dateOfBirth',
    'gender',
    'ip',
    'ipAddress',
    'userAgent',
    'politicalAffiliation',
    'geo',
    'latitude',
    'longitude',
    'fingerprint',
  ]) {
    assert.ok(
      PROHIBITED_FIELDS.includes(field),
      `PROHIBITED_FIELDS is missing "${field}" — the lint would not catch it`,
    );
  }
});

/** The declared field set for one collection. */
const fieldsOf = (collection) => declaredFieldNames(COLLECTION_VALIDATORS).get(collection);

test('no collection validator declares a prohibited field', () => {
  const offenders = [];

  for (const [collection, fields] of declaredFieldNames(COLLECTION_VALIDATORS)) {
    for (const field of fields) {
      if (PROHIBITED_FIELDS.some((banned) => banned.toLowerCase() === field.toLowerCase())) {
        offenders.push(`${collection}.${field}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Prohibited fields declared in collection validators: ${offenders.join(', ')}`,
  );
});

test('assertNoProhibitedFields rejects a validator that adds one', () => {
  const poisoned = {
    ...COLLECTION_VALIDATORS,
    reading_sessions: {
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'string' },
          gender: { bsonType: 'string' },
        },
      },
    },
  };

  assert.throws(
    () => assertNoProhibitedFields(poisoned),
    /gender/i,
    'the guard must reject a validator carrying a prohibited field',
  );
});

test('assertNoProhibitedFields accepts the real validators', () => {
  assert.doesNotThrow(() => assertNoProhibitedFields(COLLECTION_VALIDATORS));
});

test('the guard reaches nested and array-valued sub-documents', () => {
  // A profiling field buried inside `progress` or an array `items` schema would be just as
  // real as one at the top level, so the walk has to find it there too.
  const nested = {
    ...COLLECTION_VALIDATORS,
    reading_sessions: {
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          progress: {
            bsonType: 'object',
            properties: {
              entries: {
                bsonType: 'array',
                items: { bsonType: 'object', properties: { latitude: { bsonType: 'double' } } },
              },
            },
          },
        },
      },
    },
  };

  assert.throws(() => assertNoProhibitedFields(nested), /latitude/i);
});

test('reading_sessions carries the age band and nothing that could profile a reader', () => {
  const fields = fieldsOf('reading_sessions');
  assert.ok(fields, 'reading_sessions must have a validator — it is the privacy-critical one');

  // The band lives here and nowhere else (§9.5.1).
  assert.ok(fields.has('ageBand'), 'ageBand belongs on reading_sessions');

  // And these do not live anywhere at all.
  for (const banned of PROHIBITED_FIELDS) {
    assert.ok(!fields.has(banned), `reading_sessions must not declare "${banned}"`);
  }

  // No name, no email, no account linkage on the anonymous session (§9.2.4).
  for (const pii of ['email', 'name', 'displayName', 'passwordHash', 'accountId']) {
    assert.ok(!fields.has(pii), `reading_sessions must not declare "${pii}"`);
  }
});

test('events carries no identity beyond the anonymous session id', () => {
  const fields = fieldsOf('events');
  assert.ok(fields, 'events must have a validator');

  assert.ok(fields.has('sessionId'), 'sessionId is the only identity linkage (§9.2.5)');

  // §14.2, binding: ageRange is session state only and MUST NOT appear in any event payload.
  for (const banned of [...PROHIBITED_FIELDS, 'ageBand', 'ageRange', 'email', 'referrer']) {
    assert.ok(!fields.has(banned), `events must not declare "${banned}"`);
  }
});

test('the age band never crosses into a collection that holds PII', () => {
  // The privacy wall (§9.2.7): invitations, family_members, donations, orders and feedback
  // hold contact details. If the band appeared beside an email address, the two would be
  // joinable and the promise would be false.
  const declared = declaredFieldNames(COLLECTION_VALIDATORS);
  for (const collection of ['invitations', 'family_members', 'donations', 'orders', 'feedback']) {
    const fields = declared.get(collection);
    assert.ok(fields, `${collection} must have a validator`);
    for (const banned of ['ageBand', 'ageRange', 'contentLayer']) {
      assert.ok(!fields.has(banned), `${collection} must not declare "${banned}"`);
    }
  }
});

test('feedback carries what a reader wrote and nothing that could profile them', () => {
  const fields = fieldsOf('feedback');
  assert.ok(fields, 'feedback must have a validator');

  // What it is for: free text, a category, and the passages the reader marked (§3.4.2).
  for (const expected of ['body', 'category', 'passages', 'unitId', 'charStart', 'charEnd']) {
    assert.ok(fields.has(expected), `feedback must declare "${expected}"`);
  }

  // Contact is optional and consent-gated; the consent flag has to exist for the service to
  // have anything to gate on.
  assert.ok(fields.has('contactConsent'), 'feedback must declare contactConsent');

  // And none of this exists — §14.4.3 forbids the profiling, §9.2 keeps the band elsewhere.
  for (const banned of [...PROHIBITED_FIELDS, 'ageBand', 'ageRange', 'contentLayer', 'age']) {
    assert.ok(!fields.has(banned), `feedback must not declare "${banned}"`);
  }
});

test('assertNoProhibitedFields rejects a profiling field added to feedback', () => {
  // The realistic regression: someone decides an age band would be "useful context" on a
  // feedback record. The guard has to fail the build for the field names it can name.
  const poisoned = {
    ...COLLECTION_VALIDATORS,
    feedback: {
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'string' },
          body: { bsonType: 'string' },
          birthdate: { bsonType: 'date' },
        },
      },
    },
  };

  assert.throws(() => assertNoProhibitedFields(poisoned), /birthdate/i);
});

/** Every .js file under src/, so the source scan below is exhaustive. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no source file writes a prohibited field to a document', () => {
  // A field can reach Mongo without passing through a validator's `properties` map, so this
  // catches assignment at the call site too: `ipAddress:`, `gender:`, `birthdate:` and friends
  // appearing as object keys in application code.
  const files = sourceFiles(join(root, 'src'));
  const offenders = [];

  // `ip` alone is too short to match safely (it appears inside `description`, `script`, …), so
  // the scan uses the unambiguous spellings and lets the validator test cover the rest.
  const scanned = PROHIBITED_FIELDS.filter((field) => field.length > 3);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // Strip comments: prose about what is NOT collected is exactly what this codebase should
    // contain, and flagging it would punish the documentation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const field of scanned) {
      const asKey = new RegExp(`(^|[{,\\s])${field}\\s*:`, 'm');
      if (asKey.test(code)) {
        offenders.push(`${file.slice(root.length + 1).replace(/\\/g, '/')}: ${field}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Prohibited fields assigned in source: ${offenders.join(', ')}`,
  );
});
