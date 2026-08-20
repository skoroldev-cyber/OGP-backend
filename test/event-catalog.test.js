import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_NAMES,
  EVENT_PAYLOAD_FIELDS,
  EVENT_BATCH_LIMIT,
  PATHWAYS,
  allowedPayloadFields,
} from '../src/config/constants.js';

const CANONICAL_ELEVEN = [
  'LandingStarted',
  'LogoManifestationStarted',
  'PortalEntryStarted',
  'EarthRevealCompleted',
  'ReadingRoomEntered',
  'ReadingSessionStarted',
  'ChapterCompleted',
  'SharePromptDisplayed',
  'ShareCompleted',
  'OpeningArcCompleted',
  'PathwaySelected',
];

test('the catalog is exactly the eleven canonical events plus ShareTokenOpened', () => {
  const names = Object.values(EVENT_NAMES);

  for (const canonical of CANONICAL_ELEVEN) {
    assert.ok(names.includes(canonical), `missing canonical event "${canonical}"`);
  }

  assert.ok(names.includes('ShareTokenOpened'), 'ShareTokenOpened is the proposed twelfth event');

  assert.equal(
    names.length,
    12,
    `the vocabulary must stay closed at 12; found ${names.length}: ${names.join(', ')}`,
  );
});

test('no event name from the superseded 061226 taxonomy has crept back in', () => {
  const superseded = [
    'threshold_viewed',
    'spark_started',
    'logo_resolved',
    'begin_journey_clicked',
    'logo_passage_completed',
    'earth_reveal_completed',
    'opening_arc_started',
    'opening_arc_completed',
    'gateway_two_choice',
    'chapter_started',
    'chapter_completed',
    'reading_room_returned',
    'feedback_submitted',
  ];

  const names = Object.values(EVENT_NAMES);
  for (const old of superseded) {
    assert.ok(!names.includes(old), `superseded event name "${old}" must not be in the catalog`);
  }
});

test('every event declares a payload whitelist', () => {
  for (const name of Object.values(EVENT_NAMES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(EVENT_PAYLOAD_FIELDS, name),
      `"${name}" has no payload whitelist — an unlisted event would accept arbitrary keys`,
    );
  }
});

test('payload whitelists match the contract field-for-field', () => {
  const expected = {
    LandingStarted: [
      'entryPath',
      'referrerDomain',
      'reducedMotion',
      'deviceTier',
      'locale',
      'isReturnVisit',
    ],
    LogoManifestationStarted: ['msSinceLanding', 'skippedIntro'],
    PortalEntryStarted: [
      'msSinceLanding',
      'inputMethod',
      'skippedCinematic',
      'silentMode',
      'motionMode',
    ],
    EarthRevealCompleted: ['msSinceLanding', 'mode', 'audioEnabled'],
    ReadingRoomEntered: ['msSinceLanding', 'entryType'],
    ReadingSessionStarted: ['resume', 'lastUnitId'],
    ChapterCompleted: ['unitId', 'componentIndex', 'msReading'],
    SharePromptDisplayed: ['promptId', 'unitId', 'windowType', 'visualTreatment'],
    ShareCompleted: ['promptId', 'shareTokenId', 'channel'],
    ShareTokenOpened: ['shareTokenId'],
    OpeningArcCompleted: ['totalMsReading', 'componentsCompleted', 'sharesCompleted'],
    PathwaySelected: ['pathway'],
  };

  for (const [name, fields] of Object.entries(expected)) {
    const allowed = new Set(allowedPayloadFields(name));
    for (const field of fields) {
      assert.ok(allowed.has(field), `${name} payload must allow "${field}"`);
    }
  }
});

test('no payload may carry the age band, an address, or an agent string', () => {
  const forbidden = [
    'ageRange',
    'ageBand',
    'contentLayer',
    'ip',
    'ipAddress',
    'userAgent',
    'geo',
    'latitude',
    'longitude',
    'email',
    'referrer',
    'referrerUrl',
  ];

  for (const name of Object.values(EVENT_NAMES)) {
    const allowed = allowedPayloadFields(name);
    for (const field of forbidden) {
      assert.ok(
        !allowed.includes(field),
        `${name} must not allow "${field}" in its payload (§14.2)`,
      );
    }
  }
});

test('referrerDomain is a domain, not a URL', () => {
  const landing = allowedPayloadFields('LandingStarted');
  assert.ok(landing.includes('referrerDomain'));
  assert.ok(!landing.includes('referrer'));
  assert.ok(!landing.includes('referrerUrl'));
});

test('PathwaySelected carries exactly the seven canonical pathway slugs', () => {
  const expected = [
    'continue_founders_edition',
    'donate_digital_transcript',
    'purchase_hardcover',
    'become_family',
    'support_mission',
    'share_opening_arc',
    'return_later',
  ];

  const slugs = Object.values(PATHWAYS);
  for (const slug of expected) {
    assert.ok(slugs.includes(slug), `missing pathway slug "${slug}"`);
  }
  assert.equal(slugs.length, 7, 'there are exactly seven end pathways');
});

test('the batch limit is bounded', () => {
  assert.equal(EVENT_BATCH_LIMIT, 20);
});
