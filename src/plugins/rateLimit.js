import rateLimit from '@fastify/rate-limit';
import { bearerFromHeader, rateLimitKeyForToken } from '../lib/tokens.js';

const HEADER_LABELS = Object.freeze([
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
]);

const SILENT_HEADERS = Object.freeze(
  Object.fromEntries(HEADER_LABELS.map((label) => [label, false])),
);

function ipKey(request) {
  return request.ip;
}

function sessionKey(request) {
  const token = bearerFromHeader(request.headers.authorization);
  return token === null ? `anon:${request.ip}` : `s:${rateLimitKeyForToken(token)}`;
}

function adminTokenKey(request) {
  const token = bearerFromHeader(request.headers.authorization);
  return token === null ? `anon:${request.ip}` : `a:${rateLimitKeyForToken(token)}`;
}

function limitError(_request, context) {
  const error = new Error(
    context.statusCode === 403
      ? 'Too many attempts. This address is paused for a while.'
      : 'Too many requests. Please try again in a moment.',
  );
  error.statusCode = context.statusCode;
  error.code = context.statusCode === 403 ? 'RATE_LIMIT_BANNED' : 'RATE_LIMITED';
  error.expose = true;
  return error;
}

function quietShareLimit() {
  const error = new Error('share rate limit reached');
  error.statusCode = 200;
  error.code = 'SHARE_NOT_ELIGIBLE';
  error.quietResponse = { eligible: false };
  error.quietStatusCode = 200;
  return error;
}

async function rateLimitPlugin(fastify, options) {
  const { config } = options;

  if (config.rateLimit.redisUrl) {
    fastify.log.warn(
      'RATE_LIMIT_REDIS_URL is configured but the in-memory store is in use; limits are per node.',
    );
  }

  await fastify.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: ipKey,
    errorResponseBuilder: limitError,
    enableDraftSpec: false,
  });

  const budgets = Object.freeze({
    sessionCreate: Object.freeze({
      max: 10,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    eventIngest: Object.freeze({
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    shareCreate: Object.freeze({
      max: 5,
      timeWindow: '1 day',
      keyGenerator: sessionKey,
      addHeaders: SILENT_HEADERS,
      addHeadersOnExceeding: SILENT_HEADERS,
      errorResponseBuilder: quietShareLimit,
    }),

    commerceAttempt: Object.freeze({
      max: 10,
      timeWindow: '1 hour',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    adminLogin: Object.freeze({
      max: 5,
      timeWindow: '15 minutes',
      ban: 5,
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
      onBanReach() {
        fastify.log.warn(
          { alert: 'admin_login_ban' },
          'repeated failed admin sign-in attempts triggered a temporary ban',
        );
      },
    }),

    publicTokenLookup: Object.freeze({
      max: 60,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    feedbackCreate: Object.freeze({
      max: 20,
      timeWindow: '1 hour',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    readingPath: Object.freeze({
      max: 600,
      timeWindow: '1 minute',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    mailTrigger: Object.freeze({
      max: 5,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    adminBulkSend: Object.freeze({
      max: 30,
      timeWindow: '1 hour',
      keyGenerator: adminTokenKey,
      errorResponseBuilder: limitError,
    }),

    adminGeneral: Object.freeze({
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: adminTokenKey,
      errorResponseBuilder: limitError,
    }),
  });

  fastify.decorate('rateLimits', budgets);
}

rateLimitPlugin[Symbol.for('skip-override')] = true;
rateLimitPlugin[Symbol.for('fastify.display-name')] = 'ogp-rate-limit';

export default rateLimitPlugin;
