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

function isLoggerInstance(candidate) {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.child === 'function' &&
    typeof candidate.info === 'function'
  );
}

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
    pluginTimeout: config.mongo?.pluginTimeoutMs ?? 10_000,
    requestIdHeader: false,
    genReqId: () => newId(),
    trustProxy: true,
    bodyLimit: config.bodyLimitBytes,
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
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: true,
        allErrors: false,
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
    app.decorate('mongo', { client: null, db: dbOverride });
    app.decorate('db', dbOverride);
    app.decorate('collections', createCollections(dbOverride));
    app.decorate('mongoReady', async () => ({ ok: true, latencyMs: 0 }));
  } else {
    await app.register(mongoPlugin, { config });
  }
  await app.register(sessionAuthPlugin, { config });
  await app.register(adminAuthPlugin, { config });

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
