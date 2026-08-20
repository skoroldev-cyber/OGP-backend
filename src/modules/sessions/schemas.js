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

export const invitationCode = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$',
  minLength: 4,
  maxLength: 64,
});

export const createSessionBody = objectSchema({
  ageBand,
  motionPreference,
  entryVia: nullableEnumOf(ENTRY_VIA),
  shareToken: opaqueToken,
  invitationCode,
});

export const createSessionResponse = objectSchema(
  {
    sessionToken: boundedString(128, 32),
    session: sessionResponse,
  },
  { required: ['sessionToken', 'session'] },
);

export const sessionEnvelope = objectSchema({ session: sessionResponse }, { required: ['session'] });

export const patchSessionBody = objectSchema({
  ageBand,
  currentState: stateCode,
  immersionState,
  paceMode,
  currentUnitId: identifier,
  motionPreference,
  audioEnabled: { type: 'boolean' },
});

export const progressBody = objectSchema({
  completedUnitId: identifier,
  savedPassageUnitId: identifier,
  scrollFraction: { type: 'number', minimum: 0, maximum: 1 },
  readingMsDelta: { type: 'integer', minimum: 0, maximum: 86_400_000 },
});

export const progressState = objectSchema(
  {
    currentUnitId: { type: ['string', 'null'], maxLength: 64 },
    completedUnitIds: arraySchema(identifier, { maxItems: 1000 }),
    openingArcCompleted: { type: 'boolean' },
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
