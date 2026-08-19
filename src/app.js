/**
 * Fastify application assembly.
 *
 * Plugin order is load-bearing:
 *
 *   errors       → the envelope and correlation id must exist before anything can fail
 *   security     → headers on every response, including error responses
 *   cors         → the browser gate, before any route is reachable
 *   rateLimit    → budgets registered before routes attach them
 *   mongo        → the database before anything that reads it
 *   sessionAuth  → `requireSession` before routes reference it
 *   adminAuth    → `requireAdmin` before routes reference it
 *   modules      → thin route adapters, all under /api/v1
 *
 * Request logging is handled here rather than by Fastify's built-in logger, because the
 * default record includes the remote address and the raw URL. Neither may appear in a log
 * line (§9.5.2, §9.10): the URL can carry an opaque share or receipt token, and the address
 * is never retained. What is logged is the *route pattern*, the status and the duration.
 */

import Fastify, { LogController } from 'fastify';

import errorsPlugin from './plugins/errors.js';
import securityPlugin from './plugins/security.js';
import corsPlugin from './plugins/cors.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import mongoPlugin from './plugins/mongo.js';
import sessionAuthPlugin from './plugins/sessionAuth.js';
import adminAuthPlugin from './plugins/adminAuth.js';

import sessionsRoutes from './modules/sessions/routes.js';
import manuscriptRoutes from './modules/manuscript/routes.js';
import eventsRoutes from './modules/events/routes.js';
import sharingRoutes from './modules/sharing/routes.js';
import invitationsRoutes from './modules/invitations/routes.js';
import feedbackRoutes from './modules/feedback/routes.js';
import familyRoutes from './modules/family/routes.js';
import commerceRoutes from './modules/commerce/routes.js';
import adminRoutes from './modules/admin/routes.js';

import { createCollections } from './db/collections.js';
import { newId } from './lib/ids.js';

export const API_PREFIX = '/api/v1';

/** The module route plugins, in registration order. */
const MODULES = Object.freeze([
  ['sessions', sessionsRoutes],
  ['manuscript', manuscriptRoutes],
  ['events', eventsRoutes],
  ['sharing', sharingRoutes],
  ['invitations', invitationsRoutes],
  ['feedback', feedbackRoutes],
  ['family', familyRoutes],
  ['commerce', commerceRoutes],
  ['admin', adminRoutes],
]);

/**
 * A pino instance exposes `child`; a plain object is pino configuration.
 *
 * @param {unknown} candidate The `logger` option.
 * @returns {boolean} True when it is already a logger.
 */
function isLoggerInstance(candidate) {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.child === 'function' &&
    typeof candidate.info === 'function'
  );
}

/**
 * Parse JSON while retaining the exact bytes.
 *
 * NMI signs the raw body; re-serialising parsed JSON changes it and the HMAC will never
 * verify. `request.rawBody` is therefore preserved for every JSON request — it costs one
 * buffer reference and removes an entire class of webhook bug.
 *
 * @param {import('fastify').FastifyRequest} request The request.
 * @param {Buffer} body The raw body.
 * @param {Function} done Fastify callback.
 */
function jsonParserPreservingRaw(request, body, done) {
  request.rawBody = body;
  if (body.length === 0) {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(body.toString('utf8')));
  } catch (error) {
    error.statusCode = 400;
    error.code = 'MALFORMED_JSON';
    error.expose = true;
    error.message = 'The request body is not valid JSON.';
    done(error, undefined);
  }
}

/**
 * Build a fully configured Fastify instance. The caller owns listening and shutdown.
 *
 * @param {{ config: object, logger?: object }} options Application options. `logger` may be
 *        a pino instance or pino configuration; omit it for the default.
 * @returns {Promise<import('fastify').FastifyInstance>} The ready instance.
 */
export async function buildApp({ config, logger, db: dbOverride = null }) {
  if (!config) throw new TypeError('buildApp: config is required.');

  const loggerOptions = isLoggerInstance(logger)
    ? { loggerInstance: logger }
    : {
        logger: config.logLevel === 'silent'
          ? false
          : {
              level: config.logLevel,
              base: { service: 'ogp-api', env: config.env },
              // Belt and braces: even if a record slips through with one of these, it is
              // removed before it reaches a transport.
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'headers.authorization',
                  'security_key',
                  'payment_token',
                  'tokenHash',
                  'passwordHash',
                  'totpSecretEnc',
                ],
                remove: true,
              },
              ...(logger && typeof logger === 'object' ? logger : {}),
            },
      };

  const app = Fastify({
    ...loggerOptions,
    // Atlas handshake plus validators/indexes can exceed Fastify's 10s default. `0` disables
    // the check for a remote cluster; local Mongo keeps the default so a missing mongod still
    // fails fast into read-only mode.
    pluginTimeout: config.mongo?.pluginTimeoutMs ?? 10_000,
    // Correlation ids are always minted here; a client-supplied value would be an
    // uncontrolled string in every log line.
    requestIdHeader: false,
    genReqId: () => newId(),
    // Behind a load balancer `request.ip` must reflect the real client for rate limiting.
    // It is used transiently for that and for nothing else.
    trustProxy: true,
    bodyLimit: config.bodyLimitBytes,
    // Fastify's own request log records the remote address and the raw URL. Neither may appear
    // in a log line (§9.5, §9.10): the URL can carry an opaque share or receipt token, and the
    // address is never retained. The `onResponse` hook below logs the route pattern instead.
    logController: new LogController({
      requestIdLogLabel: 'correlationId',
      disableRequestLogging: true,
    }),
    routerOptions: {
      ignoreTrailingSlash: true,
    },
    return503OnClosing: true,
    ajv: {
      customOptions: {
        // Reject unknown fields rather than silently discarding them. Every route schema
        // sets `additionalProperties: false`; a client sending an undeclared key has a bug
        // worth surfacing.
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: true,
        allErrors: false,
        // Questionnaire v2.0 answers are genuinely polymorphic — a scale answer is a number, a
        // single choice is a string, a multi-choice is an array. Ajv's strict mode warns about
        // union types on principle; here the union is the instrument's actual shape, and each
        // arm is still bounded by the same schema.
        allowUnionTypes: true,
      },
    },
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: config.bodyLimitBytes },
    jsonParserPreservingRaw,
  );

  app.decorate('config', config);
  app.decorateRequest('rawBody', null);

  // PII-free access log.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions?.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  await app.register(errorsPlugin);
  await app.register(securityPlugin, { config });
  await app.register(corsPlugin, { config });
  await app.register(rateLimitPlugin, { config });
  if (dbOverride) {
    // Dependency injection for the test suite. Booting the real route table against an
    // in-memory database is the only way to prove that the gates, the schemas and the quiet
    // refusals behave as specified — a mocked route proves nothing. Production never passes
    // this: `server.js` calls `buildApp({ config })` and gets the real driver.
    app.decorate('mongo', { client: null, db: dbOverride });
    app.decorate('db', dbOverride);
    app.decorate('collections', createCollections(dbOverride));
    app.decorate('mongoReady', async () => ({ ok: true, latencyMs: 0 }));
  } else {
    await app.register(mongoPlugin, { config });
  }
  await app.register(sessionAuthPlugin, { config });
  await app.register(adminAuthPlugin, { config });

  /**
   * Liveness only. No version, no build id, no dependency detail — a public probe is not a
   * place to disclose what is running (§9.3.3).
   */
  app.get(
    '/healthz',
    {
      logLevel: 'warn',
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  for (const [name, routes] of MODULES) {
    await app.register(routes, { prefix: API_PREFIX, config, moduleName: name });
  }

  await app.ready();
  return app;
}

export default buildApp;
