/**
 * Invitation routes — `POST /invitations/redeem`.
 *
 * One route. Creating and revoking invitations is admin work and lives behind the admin
 * surface; a reader can only present a code they were given.
 */

import { createInvitationsService } from './service.js';
import {
  invitationErrorResponses,
  invitationHeaders,
  redeemBody,
  redeemResponse,
} from './schemas.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the route is registered.
 */
export default async function routes(app, _opts) {
  const service = createInvitationsService({ db: app.db, logger: app.log });

  app.post(
    '/invitations/redeem',
    {
      preHandler: app.requireSession,
      // Codes are opaque and single-use; the reading-path budget is generous enough for a
      // reader and tight enough to make guessing pointless alongside the 404-for-everything
      // response.
      config: { rateLimit: app.rateLimits.publicTokenLookup },
      schema: {
        headers: invitationHeaders,
        body: redeemBody,
        response: {
          200: redeemResponse,
          ...invitationErrorResponses,
        },
      },
    },
    async (request) =>
      service.redeem(request.session, request.body, { correlationId: request.id }),
  );
}
