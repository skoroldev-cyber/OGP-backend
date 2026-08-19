/**
 * The canonical event catalog is a closed vocabulary.
 *
 * §9.2.5, binding: "these 11 events govern; the earlier 061226 taxonomy is superseded — never
 * run a second vocabulary." A drifting event name is not a cosmetic problem: the admin funnel
 * (§10.4) is computed from these names, and a renamed event silently zeroes a metric.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_NAMES,
  EVENT_PAYLOAD_FIELDS,
  EVENT_BATCH_LIMIT,
  PATHWAYS,
  allowedPayloadFields,
} from '../src/config/constants.js';

/** The eleven canonical events from the Phase 1 State Machine Specification, in order. */
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

  // The twelfth is [PROPOSED]: arrival via a share link, receiver side.
  assert.ok(names.includes('ShareTokenOpened'), 'ShareTokenOpened is the proposed twelfth event');

  assert.equal(
    names.length,
    12,
    `the vocabulary must stay closed at 12; found ${names.length}: ${names.join(', ')}`,
  );
});

test('no event name from the superseded 061226 taxonomy has crept back in', () => {
  // Running two vocabularies at once is the specific failure §9.2.5 forbids.
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
  // BUILD_CONTRACT §3.
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
  // §14.2, binding: "ageRange is session state only and MUST NOT appear in any event payload."
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
  // A full referrer URL can carry an opaque share token in its path. Only the domain is kept.
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
  // §9.3.1: batches of at most 20. Unbounded batches turn a fire-and-forget write path into a
  // denial-of-service surface.
  assert.equal(EVENT_BATCH_LIMIT, 20);
});
