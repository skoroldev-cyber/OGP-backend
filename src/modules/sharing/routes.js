/**
 * Sharing routes.
 *
 * `POST /shares` carries the `shareCreate` budget — 5 per day per session. That budget is
 * configured to suppress every rate-limit header and to resolve into the ordinary quiet
 * `200 { eligible: false }` rather than a `429`, because "the reader must never feel the
 * system wants something from them" cuts both ways: the system must not appear to be
 * counting, and it must not scold.
 *
 * `GET /shares/:token` is public — a receiver has no session yet. It is rate limited by
 * address so an opaque 21-character token cannot be enumerated cheaply.
 */

import { createSharingService } from './service.js';
import {
  createShareBody,
  createShareResponse,
  eligibilityResponse,
  emptyResponse,
  quietRefusalResponse,
  shareLookupResponse,
  shareTokenParams,
  sharingErrorResponses,
  sharingHeaders,
} from './schemas.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const service = createSharingService({
    db: app.db,
    config: appConfig,
    logger: app.log,
  });

  app.get(
    '/sharing/eligibility',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sharingHeaders,
        response: {
          200: eligibilityResponse,
          ...sharingErrorResponses,
        },
      },
    },
    async (request) => service.eligibility(request.session),
  );

  app.post(
    '/shares',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.shareCreate },
      schema: {
        headers: sharingHeaders,
        body: createShareBody,
        response: {
          200: quietRefusalResponse,
          201: createShareResponse,
          ...sharingErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.createShare(request.session, request.body ?? {});
      if (!result.created) {
        reply.code(200);
        return { eligible: false };
      }
      reply.code(201);
      return { shareUrl: result.shareUrl, token: result.token };
    },
  );

  app.post(
    '/shares/:token/revoke',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sharingHeaders,
        params: shareTokenParams,
        response: {
          204: emptyResponse,
          ...sharingErrorResponses,
        },
      },
    },
    async (request, reply) => {
      await service.revoke(request.session, request.params.token);
      return reply.code(204).send();
    },
  );

  app.get(
    '/shares/:token',
    {
      config: { rateLimit: app.rateLimits.publicTokenLookup },
      schema: {
        params: shareTokenParams,
        response: {
          200: shareLookupResponse,
          ...sharingErrorResponses,
        },
      },
    },
    async (request) => service.openShare(request.params.token),
  );
}
