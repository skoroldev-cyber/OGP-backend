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

  assert.ok(fields.has('ageBand'), 'ageBand belongs on reading_sessions');

  for (const banned of PROHIBITED_FIELDS) {
    assert.ok(!fields.has(banned), `reading_sessions must not declare "${banned}"`);
  }

  for (const pii of ['email', 'name', 'displayName', 'passwordHash', 'accountId']) {
    assert.ok(!fields.has(pii), `reading_sessions must not declare "${pii}"`);
  }
});

test('events carries no identity beyond the anonymous session id', () => {
  const fields = fieldsOf('events');
  assert.ok(fields, 'events must have a validator');

  assert.ok(fields.has('sessionId'), 'sessionId is the only identity linkage (§9.2.5)');

  for (const banned of [...PROHIBITED_FIELDS, 'ageBand', 'ageRange', 'email', 'referrer']) {
    assert.ok(!fields.has(banned), `events must not declare "${banned}"`);
  }
});

test('the age band never crosses into a collection that holds PII', () => {
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

  for (const expected of ['body', 'category', 'passages', 'unitId', 'charStart', 'charEnd']) {
    assert.ok(fields.has(expected), `feedback must declare "${expected}"`);
  }

  assert.ok(fields.has('contactConsent'), 'feedback must declare contactConsent');

  for (const banned of [...PROHIBITED_FIELDS, 'ageBand', 'ageRange', 'contentLayer', 'age']) {
    assert.ok(!fields.has(banned), `feedback must not declare "${banned}"`);
  }
});

test('assertNoProhibitedFields rejects a profiling field added to feedback', () => {
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
  const files = sourceFiles(join(root, 'src'));
  const offenders = [];

  const scanned = PROHIBITED_FIELDS.filter((field) => field.length > 3);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
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
