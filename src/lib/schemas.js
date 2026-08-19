/**
 * Shared JSON-Schema fragments.
 *
 * Fastify validates every request and every response against these. Two rules hold
 * throughout the codebase:
 *
 *  1. **`additionalProperties: false` on every object.** Use {@link objectSchema} and it is
 *     applied for you. An unexpected key is a defect, not something to ignore.
 *  2. **Every string has a length cap.** An uncapped string is a memory-exhaustion vector
 *     and a place for free text to leak into a store that must not hold it.
 *
 * Response schemas double as an outbound filter: Fastify serialises only declared
 * properties, so an internal field cannot escape by accident. Editorial internals,
 * resonance scores and no-share flags never appear in a reader-facing schema.
 */

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

/* -------------------------------------------------------------------------- */
/* Primitive fragments                                                         */
/* -------------------------------------------------------------------------- */

/** A 26-character Crockford base32 ULID — the shape of every `_id`. */
export const ulid = Object.freeze({
  type: 'string',
  pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
  minLength: 26,
  maxLength: 26,
});

/** A prefixed or bare document identifier, as used for `unitId`, `promptId`, `cohortId`. */
export const identifier = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
  minLength: 1,
  maxLength: 64,
});

/** A 21-character opaque URL token (share links, invitation codes, access grants). */
export const opaqueToken = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{16,64}$',
  minLength: 16,
  maxLength: 64,
});

/** An ISO-8601 date-time string. */
export const isoDate = Object.freeze({
  type: 'string',
  format: 'date-time',
  maxLength: 40,
});

/** An email address. The only PII field the platform ever accepts from a reader. */
export const email = Object.freeze({
  type: 'string',
  format: 'email',
  minLength: 3,
  maxLength: 254,
});

/** Integer cents. Never a float — money is not a double. */
export const amountCents = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: 100_000_000,
});

/** ISO-4217 currency. USD only in Phase 1 (the merchant profile is USD-only). */
export const currency = Object.freeze({
  type: 'string',
  enum: ['USD'],
});

/** An application-level idempotency key supplied by the client on every payment attempt. */
export const idempotencyKey = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
  minLength: 8,
  maxLength: 64,
});

/**
 * A length-capped string.
 *
 * @param {number} [maxLength] Maximum length.
 * @param {number} [minLength] Minimum length.
 * @returns {object} The fragment.
 */
export const boundedString = (maxLength = 256, minLength = 0) =>
  Object.freeze({ type: 'string', minLength, maxLength });

/**
 * A closed-vocabulary string.
 *
 * @param {readonly string[]} values Allowed values.
 * @returns {object} The fragment.
 */
export const enumOf = (values) => Object.freeze({ type: 'string', enum: [...values] });

/**
 * A closed-vocabulary string that may also be null.
 *
 * @param {readonly string[]} values Allowed values.
 * @returns {object} The fragment.
 */
export const nullableEnumOf = (values) =>
  Object.freeze({ type: ['string', 'null'], enum: [...values, null] });

/* -------------------------------------------------------------------------- */
/* Object helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a closed object schema. Every object schema in this codebase goes through here.
 *
 * @param {Record<string, object>} properties Declared properties.
 * @param {{ required?: string[], nullable?: boolean }} [options] Options.
 * @returns {object} The fragment.
 */
export function objectSchema(properties, options = {}) {
  const { required = [], nullable = false } = options;
  return {
    type: nullable ? ['object', 'null'] : 'object',
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

/**
 * Build an array schema with a hard item cap.
 *
 * @param {object} items Item schema.
 * @param {{ maxItems?: number, minItems?: number }} [options] Options.
 * @returns {object} The fragment.
 */
export function arraySchema(items, options = {}) {
  const { maxItems = 100, minItems = 0 } = options;
  return { type: 'array', items, minItems, maxItems };
}

/* -------------------------------------------------------------------------- */
/* Envelope fragments                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The universal error envelope. Every non-2xx response in the platform has this shape.
 */
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

/**
 * Attach the error envelope to a set of status codes.
 *
 * @param {...number} codes HTTP status codes.
 * @returns {Record<string, object>} A response-schema fragment.
 */
export function errorResponses(...codes) {
  const responses = {};
  for (const code of codes) responses[code] = errorResponse;
  return responses;
}

/**
 * The `Authorization: Bearer <token>` header carried by every **S**-authenticated route.
 * Header schemas never set `additionalProperties: false` — the transport adds headers we
 * do not control.
 */
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

/**
 * The same bearer header, not required.
 *
 * Used by the canonical reading path, which is anonymous-first (§1.7.1). A reader who presents
 * a session gets the rendering their session selects; a reader who presents nothing gets the
 * default. Neither can name a layer.
 */
export const optionalSessionTokenHeader = Object.freeze({
  type: 'object',
  properties: { ...sessionTokenHeader.properties },
});

/** The admin JWT header. Same shape, different meaning — kept separate for readability. */
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

/** The NMI webhook signature header. */
export const webhookSignatureHeader = Object.freeze({
  type: 'object',
  required: ['webhook-signature'],
  properties: {
    'webhook-signature': { type: 'string', minLength: 8, maxLength: 512 },
  },
});

/** Cursor-free pagination for admin listings. Aggregate views never need deep paging. */
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

/** A `204 No Content` response. */
export const noContentResponse = Object.freeze({ type: 'null' });

/* -------------------------------------------------------------------------- */
/* Domain fragments                                                            */
/* -------------------------------------------------------------------------- */

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

/**
 * The reader-facing session projection. `gates` are server-computed and read-only;
 * nothing here identifies a person.
 */
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

/** The shape of one item inside a `POST /events` batch. */
export const eventEnvelope = objectSchema(
  {
    name: eventName,
    occurredAt: isoDate,
    // Payload keys are whitelisted per event name by the events service, which is why the
    // transport schema stays permissive here: an unknown key is dropped, never fatal.
    payload: { type: 'object' },
  },
  { required: ['name', 'occurredAt'] },
);

/** Free-text caps for reader-supplied strings that legitimately exist (questionnaires). */
export const shortText = boundedString(280);
export const longText = boundedString(4000);

/** A shipping address. Collected only for physical goods, never for a contribution. */
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
