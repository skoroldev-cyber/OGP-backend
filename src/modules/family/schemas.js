/**
 * "Become Family." schemas.
 *
 * **Vocabulary is a hard constraint here, not a style note.** `rules.json` prohibits
 * "join", "sign up", "become a member" and "membership"; §9.2.10 rules that no reader-facing
 * string on this pathway may contain "member" in any form. Every field name and every
 * message in this module and its service is held to that: the collection name is internal,
 * the API speaks only family vocabulary, and `lib/rulesLint.js` enforces the rule on the
 * copy constant the service records consent against.
 *
 * `communicationPreference` is **required and has no default**. There is no default-on
 * mailing: a reader who does not choose "updates" receives nothing, and the schema makes it
 * impossible to create a record without an explicit choice having been made.
 */

import {
  boundedString,
  email,
  enumOf,
  errorResponses,
  objectSchema,
  opaqueToken,
  sessionTokenHeader,
} from '../../lib/schemas.js';

/** The two possible answers. Neither is a default; the reader states one. */
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

/**
 * Withdrawal is self-service and public — a reader who no longer holds a session must still
 * be able to leave.
 *
 * Two shapes, one route. `{ email }` starts the flow and sends one confirming link;
 * `{ token }` is that link coming back, and completes it. BUILD_CONTRACT §4.3 specifies the
 * first and describes the second ("emailed confirm link, self-service") without giving it
 * an endpoint, so it is carried here rather than invented as a new route.
 */
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
