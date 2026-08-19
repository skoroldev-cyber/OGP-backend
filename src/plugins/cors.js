/**
 * Cross-origin access.
 *
 * The allow-list comes from `CORS_ORIGINS` and nowhere else — no wildcard, no reflection
 * of an arbitrary `Origin` header, no environment-conditional loosening. An empty list
 * denies every browser client, which is why the configuration loader treats an empty
 * `CORS_ORIGINS` as a fatal error in production rather than a permissive default.
 *
 * Credentials are disabled: readers authenticate with a bearer token in a header, not a
 * cookie, so there is no ambient authority for a cross-site request to abuse.
 */

import cors from '@fastify/cors';

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

const ALLOWED_HEADERS = Object.freeze([
  'authorization',
  'content-type',
  'accept',
  'if-none-match',
]);

/** Response headers the browser may read. `x-correlation-id` lets a reader quote an id. */
const EXPOSED_HEADERS = Object.freeze(['x-correlation-id', 'etag', 'retry-after']);

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @param {{ config: object }} options Plugin options.
 * @returns {Promise<void>} Resolves when registered.
 */
async function corsPlugin(fastify, options) {
  const { config } = options;
  const allowed = new Set(config.origins.corsOrigins);

  if (allowed.size === 0) {
    fastify.log.warn(
      'CORS_ORIGINS is empty: every cross-origin browser request will be refused.',
    );
  }

  await fastify.register(cors, {
    /**
     * @param {string|undefined} origin The request Origin, absent for same-origin and
     *        non-browser callers.
     * @param {Function} callback Node-style callback.
     */
    origin(origin, callback) {
      // No Origin header: a same-origin request, a server-to-server call, or a webhook.
      // CORS has nothing to say about these.
      if (origin === undefined || origin === null) {
        callback(null, true);
        return;
      }
      callback(null, allowed.has(origin));
    },
    credentials: false,
    methods: [...ALLOWED_METHODS],
    allowedHeaders: [...ALLOWED_HEADERS],
    exposedHeaders: [...EXPOSED_HEADERS],
    maxAge: 600,
    strictPreflight: false,
  });
}

corsPlugin[Symbol.for('skip-override')] = true;
corsPlugin[Symbol.for('fastify.display-name')] = 'ogp-cors';

export default corsPlugin;
