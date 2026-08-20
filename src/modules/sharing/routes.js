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
