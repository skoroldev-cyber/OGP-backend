/**
 * Session route schemas.
 *
 * Two properties of these schemas are load-bearing rather than cosmetic:
 *
 * 1. **`gates` appears in no request schema.** With `additionalProperties: false` and Ajv
 *    configured `removeAdditional: false`, a client that tries to write its own protection
 *    gates receives a `400`, not a silent drop. The gates are computed server-side from
 *    content position and flags, and there is no path by which a client can influence them.
 * 2. **No reader-state signal is accepted.** `emotional_load`, `fatigue_level`,
 *    `sharing_readiness` and their siblings stay unpopulated in Phase 1 (protection-only
 *    doctrine, §3.6.4). There is deliberately no field here to carry one, and no scroll
 *    velocity or dwell time is accepted anywhere.
 */

import { ENTRY_VIA } from '../../config/constants.js';
import {
  ageBand,
  arraySchema,
  boundedString,
  errorResponses,
  identifier,
  immersionState,
  motionPreference,
  noContentResponse,
  nullableEnumOf,
  objectSchema,
  opaqueToken,
  paceMode,
  sessionResponse,
  sessionTokenHeader,
  stateCode,
} from '../../lib/schemas.js';

/**
 * Invitation codes are opaque and single-use, but they are also read aloud and typed by
 * hand for organisation cohorts ("ALA-2026"), so the shape is wider than a URL token.
 */
export const invitationCode = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$',
  minLength: 4,
  maxLength: 64,
});

/** `POST /sessions` — the only public write on the reading path. */
export const createSessionBody = objectSchema({
  ageBand,
  motionPreference,
  entryVia: nullableEnumOf(ENTRY_VIA),
  shareToken: opaqueToken,
  invitationCode,
});

/**
 * The bearer token is returned exactly once. Nothing stores it but the reader's browser;
 * the server keeps only its SHA-256 hash.
 */
export const createSessionResponse = objectSchema(
  {
    sessionToken: boundedString(128, 32),
    session: sessionResponse,
  },
  { required: ['sessionToken', 'session'] },
);

export const sessionEnvelope = objectSchema({ session: sessionResponse }, { required: ['session'] });

/**
 * `PATCH /sessions/current`. An `ageBand` change is the "switch experience depth" control;
 * the server re-runs the routing function and recomputes the gates.
 */
export const patchSessionBody = objectSchema({
  ageBand,
  currentState: stateCode,
  immersionState,
  paceMode,
  currentUnitId: identifier,
  motionPreference,
  audioEnabled: { type: 'boolean' },
});

/** `POST /sessions/current/progress`. */
export const progressBody = objectSchema({
  completedUnitId: identifier,
  savedPassageUnitId: identifier,
  scrollFraction: { type: 'number', minimum: 0, maximum: 1 },
  // A single progress write reports elapsed reading time since the previous write. It is a
  // duration, never a timestamp series, and it supports no behavioural inference: the
  // server adds it to one running total and never compares it to anything.
  readingMsDelta: { type: 'integer', minimum: 0, maximum: 86_400_000 },
});

export const progressState = objectSchema(
  {
    currentUnitId: { type: ['string', 'null'], maxLength: 64 },
    completedUnitIds: arraySchema(identifier, { maxItems: 1000 }),
    openingArcCompleted: { type: 'boolean' },
    // Chapter "00" is encoded as -1 (§3.6.2); display labels always come from the authored
    // heading string, never from this number.
    chaptersCompleted: arraySchema({ type: 'integer', minimum: -1, maximum: 100 }, { maxItems: 100 }),
    savedPassageUnitIds: arraySchema(identifier, { maxItems: 1000 }),
    scrollFraction: { type: ['number', 'null'] },
    readingMs: { type: 'integer' },
    lastReadAt: { type: ['string', 'null'], format: 'date-time' },
  },
  {
    required: [
      'currentUnitId',
      'completedUnitIds',
      'openingArcCompleted',
      'chaptersCompleted',
      'savedPassageUnitIds',
      'readingMs',
    ],
  },
);

export const progressResponse = objectSchema({ progress: progressState }, { required: ['progress'] });

export const sessionHeaders = sessionTokenHeader;
export const emptyResponse = noContentResponse;
export const sessionErrorResponses = errorResponses(400, 401, 404, 429, 500, 503);
