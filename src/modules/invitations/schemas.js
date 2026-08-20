import {
  boundedString,
  errorResponses,
  objectSchema,
  sessionTokenHeader,
} from '../../lib/schemas.js';
import { invitationCode } from '../sessions/schemas.js';

export const redeemBody = objectSchema({ code: invitationCode }, { required: ['code'] });

export const redeemResponse = objectSchema(
  {
    cohort: objectSchema(
      { name: { type: ['string', 'null'], maxLength: 120 } },
      { required: ['name'] },
    ),
    edition: boundedString(64, 1),
  },
  { required: ['cohort', 'edition'] },
);

export const invitationHeaders = sessionTokenHeader;
export const invitationErrorResponses = errorResponses(400, 401, 404, 429, 500, 503);
