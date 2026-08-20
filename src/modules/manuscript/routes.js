import { createManuscriptService } from './service.js';
import {
  manifestQuery,
  manifestResponse,
  manuscriptErrorResponses,
  notModifiedResponse,
  unitHeaders,
  unitParams,
  unitResponse,
} from './schemas.js';
import { optionalSessionTokenHeader } from '../../lib/schemas.js';

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const service = createManuscriptService({
    db: app.db,
    config: appConfig,
    logger: app.log,
  });

  app.get(
    '/manuscript/manifest',
    {
      preHandler: app.optionalSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: optionalSessionTokenHeader,
        querystring: manifestQuery,
        response: {
          200: manifestResponse,
          ...manuscriptErrorResponses,
        },
      },
    },
    async (request) => service.manifest(request.query),
  );

  app.get(
    '/manuscript/units/:unitId',
    {
      preHandler: app.optionalSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: unitHeaders,
        params: unitParams,
        response: {
          200: unitResponse,
          304: notModifiedResponse,
          ...manuscriptErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { unit, etag } = await service.unit({
        unitId: request.params.unitId,
        session: request.session,
      });

      reply.header('cache-control', IMMUTABLE_CACHE_CONTROL);
      reply.header('etag', etag);
      reply.header('vary', 'authorization');

      const ifNoneMatch = request.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
        return reply.code(304).send();
      }

      return { unit };
    },
  );
}
