/**
 * Manuscript routes — `GET /manuscript/manifest`, `GET /manuscript/units/:unitId`.
 *
 * Both routes take an anonymous session *optionally*. A session lets the server choose the
 * rendering; its absence selects the default. Either way the client never names a layer, and
 * either way the manuscript is reachable — see the note above the manifest route.
 *
 * The unit route is the one place in this service that sets a cacheable policy. Releases
 * never mutate, so `public, max-age=31536000, immutable` is literally true, and the ETag
 * lets a returning reader revalidate for free. `plugins/security.js` only applies its
 * `no-store` default when no `cache-control` header is already set, so setting it here wins.
 */

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

/** One year, in seconds. A published release is addressed by version, never purged. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const service = createManuscriptService({
    db: app.db,
    config: appConfig,
    logger: app.log,
  });

  // The canonical reading path is anonymous-first (§1.7.1): "Basic reading requires no account
  // and no server-side per-user state; the entire canonical reading path must be servable from
  // CDN-cached immutable release content." A bearer token is therefore *optional* here, not
  // required — three consequences follow, and all three are the point.
  //
  //   1. Reading survives an unreachable database, which is what the read-only boot message
  //      already promises. A route that 500s when Mongo is down makes that promise false.
  //   2. `Cache-Control: immutable` becomes meaningful. A route that demands a per-reader token
  //      can never be held in a shared cache, so the header would have been decoration.
  //   3. The reader is not asked for anything before the manuscript. §1.2 is explicit that no
  //      forced signup wall exists between the reader and the text; requiring a token to fetch
  //      it is a thinner wall than a login form, but it is the same wall.
  //
  // The anti-scraping property in §9.3.1 survives intact, because it never depended on the auth:
  // the client still cannot name a layer. With a session, the server reads the layer from it.
  // Without one, it serves the default — `full_manuscript`, the only certified rendering — so an
  // anonymous caller cannot reach the youth renderings by omitting a header.
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
      // The rendering depends on the session, so a shared cache must key on it.
      reply.header('vary', 'authorization');

      const ifNoneMatch = request.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
        return reply.code(304).send();
      }

      return { unit };
    },
  );
}
