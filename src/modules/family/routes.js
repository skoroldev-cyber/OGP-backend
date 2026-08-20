import { createFamilyService } from './service.js';
import {
  createFamilyBody,
  createFamilyResponse,
  familyErrorResponses,
  familyHeaders,
  withdrawBody,
  withdrawResponse,
} from './schemas.js';

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
