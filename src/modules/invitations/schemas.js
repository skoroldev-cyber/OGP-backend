/**
 * Invitation redemption schemas.
 *
 * The privacy wall is visible in what is absent. `invitations` holds the invitee's name,
 * email, country, language and background; `reading_sessions` holds none of it. The only
 * link between them is `redeemedBySessionId`, which exists for admin completion tracking
 * and is never used for per-invitee reading-behaviour queries.
 *
 * So the response carries a cohort *name* and an edition label and nothing else. There is
 * no field here through which an address or a display name could travel back to a client,
 * and therefore no way for a reading session to learn who it belongs to.
 */

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
