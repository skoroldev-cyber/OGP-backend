/**
 * Sharing route schemas.
 *
 * `openCount` appears in no schema in this file, and it never will. It is a private
 * operational counter; rendering it — anywhere, in any form, to anyone who is not an
 * administrator — would be a share counter, which is a prohibited mechanic. The same
 * applies to first-open times, recipient activity, and any derived chain: no reader-facing
 * response in this module carries a number about other people.
 *
 * `POST /shares` declares two success shapes because ineligibility is not an error.
 * A reader who may not share right now receives a calm `200 { eligible: false }`; the UI
 * has nothing to dramatise, because there is nothing dramatic to report.
 */

import {
  boundedString,
  errorResponses,
  identifier,
  noContentResponse,
  objectSchema,
  opaqueToken,
  sessionTokenHeader,
  visualTreatment,
  windowType,
} from '../../lib/schemas.js';

/**
 * The prompt a reader may be shown. `promptText` is admin-authored copy that has passed
 * human review and the prohibited-terms lint before it can be stored, and is linted again
 * on the way out.
 */
const sharingPrompt = objectSchema(
  {
    promptId: identifier,
    promptText: boundedString(600, 1),
    visualTreatment,
    windowType,
  },
  { required: ['promptId', 'promptText', 'visualTreatment', 'windowType'] },
);

export const eligibilityResponse = objectSchema(
  {
    eligible: { type: 'boolean' },
    prompt: sharingPrompt,
  },
  { required: ['eligible'] },
);

export const createShareBody = objectSchema({ promptId: identifier });

export const createShareResponse = objectSchema(
  {
    shareUrl: boundedString(512, 1),
    token: opaqueToken,
  },
  { required: ['shareUrl', 'token'] },
);

/** The quiet refusal. Identical whichever gate declined. */
export const quietRefusalResponse = objectSchema(
  { eligible: { type: 'boolean' } },
  { required: ['eligible'] },
);

export const shareTokenParams = objectSchema({ token: opaqueToken }, { required: ['token'] });

/**
 * What a receiver's client learns from a share link: whether it is live, and that the entry
 * point is the beginning. Nothing about the sender, nothing about how many people opened it.
 */
export const shareLookupResponse = objectSchema(
  {
    valid: { type: 'boolean' },
    entry: { type: 'string', enum: ['opening'] },
  },
  { required: ['valid', 'entry'] },
);

export const sharingHeaders = sessionTokenHeader;
export const emptyResponse = noContentResponse;
export const sharingErrorResponses = errorResponses(400, 401, 404, 429, 500, 503);
