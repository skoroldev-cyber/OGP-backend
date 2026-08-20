import {
  boundedString,
  email,
  enumOf,
  errorResponses,
  objectSchema,
  opaqueToken,
  sessionTokenHeader,
} from '../../lib/schemas.js';

export const COMMUNICATION_PREFERENCES = Object.freeze(['updates', 'none']);

export const createFamilyBody = objectSchema(
  {
    email,
    displayName: boundedString(120, 1),
    communicationPreference: enumOf(COMMUNICATION_PREFERENCES),
  },
  { required: ['email', 'communicationPreference'] },
);

export const createFamilyResponse = objectSchema(
  { welcomed: { type: 'boolean' } },
  { required: ['welcomed'] },
);

export const withdrawBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    email,
    token: opaqueToken,
  },
};

export const withdrawResponse = objectSchema(
  { received: { type: 'boolean' } },
  { required: ['received'] },
);

export const familyHeaders = sessionTokenHeader;
export const familyErrorResponses = errorResponses(400, 401, 403, 409, 422, 429, 500, 503);
