import { EVENT_BATCH_LIMIT } from '../../config/constants.js';
import {
  errorResponses,
  isoDate,
  objectSchema,
  sessionTokenHeader,
} from '../../lib/schemas.js';

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

export const eventBatchResponse = objectSchema(
  { accepted: { type: 'integer', minimum: 0, maximum: EVENT_BATCH_LIMIT } },
  { required: ['accepted'] },
);

export const eventHeaders = sessionTokenHeader;
export const eventErrorResponses = errorResponses(400, 401, 413, 429, 500, 503);
