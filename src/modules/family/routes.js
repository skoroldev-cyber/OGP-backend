/**
 * "Become Family." routes.
 *
 * `POST /family` requires a session and passes the server-side rarity guard before any
 * record can exist. `POST /family/withdraw` is public, because someone who wants to leave
 * must not first have to prove they are still reading.
 *
 * Both carry the `mailTrigger` budget: each one can cause a message to be sent, and an
 * endpoint that sends mail on an address supplied by the caller is an endpoint that will be
 * pointed at someone else if it is not limited.
 */

import { createFamilyService } from './service.js';
import {
  createFamilyBody,
  createFamilyResponse,
  familyErrorResponses,
  familyHeaders,
  withdrawBody,
  withdrawResponse,
} from './schemas.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const service = createFamilyService({
    db: app.db,
    config: appConfig,
    logger: app.log,
  });

  app.post(
    '/family',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.mailTrigger },
      schema: {
        headers: familyHeaders,
        body: createFamilyBody,
        response: {
          201: createFamilyResponse,
          ...familyErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.becomeFamily(request.session, request.body);
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/family/withdraw',
    {
      config: { rateLimit: app.rateLimits.mailTrigger },
      schema: {
        body: withdrawBody,
        response: {
          202: withdrawResponse,
          ...familyErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.withdraw(request.body ?? {}, { correlationId: request.id });
      reply.code(202);
      return result;
    },
  );
}
