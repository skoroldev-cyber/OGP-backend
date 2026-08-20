import {
  AGE_BANDS,
  CONTENT_LAYERS,
  EVENT_NAMES,
  IMMERSION_STATES,
  MOTION_PREFERENCES,
  PACE_MODES,
  PATHWAYS,
  STATE_CODES,
  VISUAL_TREATMENTS,
  WINDOW_TYPES,
} from '../config/constants.js';

export const ulid = Object.freeze({
  type: 'string',
  pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
  minLength: 26,
  maxLength: 26,
});

export const identifier = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
  minLength: 1,
  maxLength: 64,
});

export const opaqueToken = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{16,64}$',
  minLength: 16,
  maxLength: 64,
});

export const isoDate = Object.freeze({
  type: 'string',
  format: 'date-time',
  maxLength: 40,
});

export const email = Object.freeze({
  type: 'string',
  format: 'email',
  minLength: 3,
  maxLength: 254,
});

export const amountCents = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: 100_000_000,
});

export const currency = Object.freeze({
  type: 'string',
  enum: ['USD'],
});

export const idempotencyKey = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
  minLength: 8,
  maxLength: 64,
});

export const boundedString = (maxLength = 256, minLength = 0) =>
  Object.freeze({ type: 'string', minLength, maxLength });

export const enumOf = (values) => Object.freeze({ type: 'string', enum: [...values] });

export const nullableEnumOf = (values) =>
  Object.freeze({ type: ['string', 'null'], enum: [...values, null] });

// A querystring carries text and nothing else. Ajv runs with `coerceTypes: false` so that a JSON
// body cannot pass a string off as the number or boolean a schema asked for, and that strictness
// necessarily reaches the query too — which means a query parameter declared `integer` or
// `boolean` can never validate, however well-formed the request. Numeric and flag parameters
// therefore declare the text they actually arrive as, and the handler recovers the value with
// `toPaging` or `toFlag`.
export const queryCount = (maxDigits = 6) =>
  Object.freeze({
    type: 'string',
    pattern: `^(0|[1-9][0-9]{0,${maxDigits - 1}})$`,
    maxLength: maxDigits,
  });

export const queryFlag = Object.freeze({ type: 'string', enum: ['true', 'false'] });

export const toFlag = (value) => (value === undefined ? undefined : value === 'true');

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;
export const PAGE_SKIP_MAX = 100_000;

const withinBounds = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

// The bounds live here rather than in the schema because the pattern above can only police the
// shape of the digits, not their size.
export const toPaging = (query = {}, defaultLimit = PAGE_LIMIT_DEFAULT) => ({
  limit: withinBounds(query.limit, defaultLimit, 1, PAGE_LIMIT_MAX),
  skip: withinBounds(query.offset, 0, 0, PAGE_SKIP_MAX),
});

export function objectSchema(properties, options = {}) {
  const { required = [], nullable = false } = options;
  return {
    type: nullable ? ['object', 'null'] : 'object',
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

export function arraySchema(items, options = {}) {
  const { maxItems = 100, minItems = 0 } = options;
  return { type: 'array', items, minItems, maxItems };
}

export const errorResponse = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', maxLength: 64 },
        message: { type: 'string', maxLength: 512 },
      },
    },
  },
});

export function errorResponses(...codes) {
  const responses = {};
  for (const code of codes) responses[code] = errorResponse;
  return responses;
}

export const sessionTokenHeader = Object.freeze({
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      pattern: '^Bearer [A-Za-z0-9\\-._~+/]+=*$',
      minLength: 16,
      maxLength: 2048,
    },
  },
});

export const optionalSessionTokenHeader = Object.freeze({
  type: 'object',
  properties: { ...sessionTokenHeader.properties },
});

export const adminTokenHeader = Object.freeze({
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      pattern: '^Bearer [A-Za-z0-9\\-._~+/]+=*$',
      minLength: 16,
      maxLength: 4096,
    },
  },
});

export const webhookSignatureHeader = Object.freeze({
  type: 'object',
  required: ['webhook-signature'],
  properties: {
    'webhook-signature': { type: 'string', minLength: 8, maxLength: 512 },
  },
});

export const paginationQuery = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'integer', minimum: 0, maximum: 100_000, default: 0 },
    from: isoDate,
    to: isoDate,
  },
});

export const noContentResponse = Object.freeze({ type: 'null' });

export const ageBand = nullableEnumOf(AGE_BANDS);
export const contentLayer = nullableEnumOf(CONTENT_LAYERS);
export const stateCode = nullableEnumOf(STATE_CODES);
export const immersionState = nullableEnumOf(IMMERSION_STATES);
export const paceMode = nullableEnumOf(PACE_MODES);
export const motionPreference = nullableEnumOf(MOTION_PREFERENCES);
export const pathway = enumOf(PATHWAYS);
export const eventName = enumOf(EVENT_NAMES);
export const windowType = enumOf(WINDOW_TYPES);
export const visualTreatment = enumOf(VISUAL_TREATMENTS);

export const sessionResponse = objectSchema({
  sessionId: ulid,
  ageBand,
  contentLayer,
  currentState: stateCode,
  immersionState,
  paceMode,
  motionPreference,
  audioEnabled: { type: ['boolean', 'null'] },
  entryVia: nullableEnumOf(['direct', 'share_token', 'invitation']),
  isFoundingReader: { type: 'boolean' },
  cohortId: { type: ['string', 'null'], maxLength: 64 },
  skipUsed: { type: ['boolean', 'null'] },
  gates: objectSchema({
    allowPrompting: { type: 'boolean' },
    allowSharing: { type: 'boolean' },
    allowBecomeFamily: { type: 'boolean' },
  }),
  progress: objectSchema({
    currentUnitId: { type: ['string', 'null'], maxLength: 64 },
    completedUnitIds: arraySchema(identifier, { maxItems: 500 }),
    openingArcCompleted: { type: 'boolean' },
    chaptersCompleted: arraySchema({ type: 'integer', minimum: 0, maximum: 100 }, {
      maxItems: 100,
    }),
    savedPassageUnitIds: arraySchema(identifier, { maxItems: 500 }),
    lastReadAt: { type: ['string', 'null'], format: 'date-time' },
  }),
  expiresAt: { type: ['string', 'null'], format: 'date-time' },
});

export const eventEnvelope = objectSchema(
  {
    name: eventName,
    occurredAt: isoDate,
    payload: { type: 'object' },
  },
  { required: ['name', 'occurredAt'] },
);

export const shortText = boundedString(280);
export const longText = boundedString(4000);

export const shippingAddress = objectSchema(
  {
    name: boundedString(120, 1),
    line1: boundedString(160, 1),
    line2: boundedString(160),
    city: boundedString(80, 1),
    region: boundedString(80),
    postalCode: boundedString(24),
    country: { type: 'string', pattern: '^[A-Z]{2}$', minLength: 2, maxLength: 2 },
  },
  { required: ['name', 'line1', 'city', 'country'] },
);
