/**
 * Session routes.
 *
 * `POST /sessions` is the only public write on the reading path, rate limited to 10 per
 * hour per address. The address is used transiently as a limiter key and is never written
 * to a document or a log line.
 *
 * Everything else here requires the bearer token minted by that route. A missing, unknown
 * or expired token produces the same `401 SESSION_REQUIRED`, so an opaque string cannot be
 * probed for existence.
 */

import { createSessionsService } from './service.js';
import {
  createSessionBody,
  createSessionResponse,
  emptyResponse,
  patchSessionBody,
  progressBody,
  progressResponse,
  sessionEnvelope,
  sessionErrorResponses,
  sessionHeaders,
} from './schemas.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const service = createSessionsService({
    db: app.db,
    config: appConfig,
    logger: app.log,
  });

  app.post(
    '/sessions',
    {
      config: { rateLimit: app.rateLimits.sessionCreate },
      schema: {
        body: createSessionBody,
        response: {
          201: createSessionResponse,
          ...sessionErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.createSession(request.body ?? {});
      reply.code(201);
      return result;
    },
  );

  app.get(
    '/sessions/current',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sessionHeaders,
        response: {
          200: sessionEnvelope,
          ...sessionErrorResponses,
        },
      },
    },
    async (request) => ({ session: service.current(request.session) }),
  );

  app.patch(
    '/sessions/current',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sessionHeaders,
        body: patchSessionBody,
        response: {
          200: sessionEnvelope,
          ...sessionErrorResponses,
        },
      },
    },
    async (request) => ({
      session: await service.updateSession(request.session, request.body ?? {}),
    }),
  );

  app.post(
    '/sessions/current/progress',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sessionHeaders,
        body: progressBody,
        response: {
          200: progressResponse,
          ...sessionErrorResponses,
        },
      },
    },
    async (request) => ({
      progress: await service.recordProgress(request.session, request.body ?? {}),
    }),
  );

  app.delete(
    '/sessions/current',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: sessionHeaders,
        response: {
          204: emptyResponse,
          ...sessionErrorResponses,
        },
      },
    },
    async (request, reply) => {
      await service.eraseSession(request.session, { correlationId: request.id });
      return reply.code(204).send();
    },
  );
}
