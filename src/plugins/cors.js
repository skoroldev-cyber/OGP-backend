import cors from '@fastify/cors';

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

const ALLOWED_HEADERS = Object.freeze([
  'authorization',
  'content-type',
  'accept',
  'if-none-match',
]);

const EXPOSED_HEADERS = Object.freeze(['x-correlation-id', 'etag', 'retry-after']);

async function corsPlugin(fastify, options) {
  const { config } = options;
  const allowed = new Set(config.origins.corsOrigins);

  if (allowed.size === 0) {
    fastify.log.warn(
      'CORS_ORIGINS is empty: every cross-origin browser request will be refused.',
    );
  }

  await fastify.register(cors, {
    origin(origin, callback) {
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
