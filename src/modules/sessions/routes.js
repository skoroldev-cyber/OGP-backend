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
