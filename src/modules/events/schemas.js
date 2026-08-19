/**
 * Event ingest schemas.
 *
 * Two deliberate looseness decisions, both in service of the same rule — **an item-wise
 * problem must never fail the batch** (BUILD_CONTRACT §3, §4.3):
 *
 * 1. `name` is a bounded string here rather than the `EVENT_NAMES` enum. If the transport
 *    schema enforced the catalog, one typo from an out-of-date client would turn a batch of
 *    twenty good events into a `400` and lose all of them. The service checks every name
 *    against `EVENT_NAMES` and silently drops the ones that do not belong.
 * 2. `payload` is an open object. The per-event whitelist is applied item-wise in the
 *    service, exactly as `lib/schemas.js` documents for the shared `eventEnvelope`
 *    fragment; an unknown key is dropped, never fatal.
 *
 * Every other object in this file is closed.
 */

import { EVENT_BATCH_LIMIT } from '../../config/constants.js';
import {
  errorResponses,
  isoDate,
  objectSchema,
  sessionTokenHeader,
} from '../../lib/schemas.js';

/** One item of the wire envelope. */
const eventItem = objectSchema(
  {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    occurredAt: isoDate,
    payload: { type: 'object', maxProperties: 40 },
  },
  { required: ['name', 'occurredAt'] },
);

export const eventBatchBody = objectSchema(
  {
    events: {
      type: 'array',
      minItems: 1,
      maxItems: EVENT_BATCH_LIMIT,
      items: eventItem,
    },
  },
  { required: ['events'] },
);

/** `202 { accepted }` — how many items of the batch were kept. */
export const eventBatchResponse = objectSchema(
  { accepted: { type: 'integer', minimum: 0, maximum: EVENT_BATCH_LIMIT } },
  { required: ['accepted'] },
);

export const eventHeaders = sessionTokenHeader;
export const eventErrorResponses = errorResponses(400, 401, 413, 429, 500, 503);
