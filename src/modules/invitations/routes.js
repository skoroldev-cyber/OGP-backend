import { createInvitationsService } from './service.js';
import {
  invitationErrorResponses,
  invitationHeaders,
  redeemBody,
  redeemResponse,
} from './schemas.js';

export default async function routes(app, _opts) {
  const service = createInvitationsService({ db: app.db, logger: app.log });

  app.post(
    '/invitations/redeem',
    {
      preHandler: app.requireSession,
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
