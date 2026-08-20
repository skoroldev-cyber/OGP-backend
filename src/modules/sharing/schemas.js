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

export const quietRefusalResponse = objectSchema(
  { eligible: { type: 'boolean' } },
  { required: ['eligible'] },
);

export const shareTokenParams = objectSchema({ token: opaqueToken }, { required: ['token'] });

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
