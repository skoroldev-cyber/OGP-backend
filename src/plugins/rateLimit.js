/**
 * Rate limiting — the §9.6 budgets, expressed as named configurations routes attach.
 *
 *   session creation      10 / hour  / IP
 *   event batches         60 / minute / session
 *   share creation         5 / day    / session   (quiet failure — see below)
 *   donation + order      10 / hour   / session
 *   admin login            5 / 15 min / IP, with backoff
 *   admin bulk send       30 / hour   / admin      (§10.10.1)
 *   admin, everything else 300 / minute / admin    (§10.10.1)
 *
 * **IP addresses are used transiently for keying and are never persisted or logged.**
 * The limiter's in-memory store holds a key and a counter; the key derived from an IP
 * lives only as long as its window, and no code path writes it to a document or a log
 * line. Session keys are an HMAC of the bearer token — non-reversible, and useless to
 * anyone who obtains the store.
 *
 * Share creation fails *quietly*: a reader who has already shared today receives an
 * ordinary `200 { eligible: false }`, not a 429. The Sharing Law forbids the system
 * appearing to want something from the reader, and an error page about sharing limits
 * would do exactly that.
 *
 * `RATE_LIMIT_REDIS_URL` is declared for the multi-node upgrade path (§9.8). No Redis
 * client is a permitted dependency yet, so the in-memory store remains in use and the
 * configuration loader warns when the variable is set.
 */

import rateLimit from '@fastify/rate-limit';
import { bearerFromHeader, rateLimitKeyForToken } from '../lib/tokens.js';

const HEADER_LABELS = Object.freeze([
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
]);

/** Suppress every rate-limit header — used where the limit must be invisible. */
const SILENT_HEADERS = Object.freeze(
  Object.fromEntries(HEADER_LABELS.map((label) => [label, false])),
);

/**
 * Key by connection address. Transient: never stored, never logged.
 *
 * @param {import('fastify').FastifyRequest} request The request.
 * @returns {string} The limiter key.
 */
function ipKey(request) {
  return request.ip;
}

/**
 * Key by session. Derived from the bearer token with the session HMAC secret, so the key
 * cannot be turned back into a token. Falls back to the connection address for a request
 * that carries no bearer at all.
 *
 * @param {import('fastify').FastifyRequest} request The request.
 * @returns {string} The limiter key.
 */
function sessionKey(request) {
  const token = bearerFromHeader(request.headers.authorization);
  return token === null ? `anon:${request.ip}` : `s:${rateLimitKeyForToken(token)}`;
}

/**
 * Key by the administrator's own access token, not by address.
 *
 * Address keying is wrong for the panel: operations staff share an office and therefore an
 * address, so one coordinator running a batch would throttle the rest of the team. The bearer
 * is hashed the same way a reader session is, so the stored key cannot be turned back into a
 * token. Requests are keyed at `onRequest`, before `requireAdmin` has resolved the account —
 * hence the token rather than `request.admin`, which does not exist yet.
 *
 * @param {import('fastify').FastifyRequest} request The request.
 * @returns {string} The limiter key.
 */
function adminTokenKey(request) {
  const token = bearerFromHeader(request.headers.authorization);
  return token === null ? `anon:${request.ip}` : `a:${rateLimitKeyForToken(token)}`;
}

/**
 * The standard 429. Calm wording, no countdown, no urgency.
 *
 * @param {import('fastify').FastifyRequest} _request The request.
 * @param {{ statusCode: number, after: string }} context Limiter context.
 * @returns {Error} The error the limiter throws.
 */
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

/**
 * The share-creation limit resolves to an ordinary, quiet `200 { eligible: false }`.
 * `plugins/errors.js` recognises `quietResponse` and sends it verbatim.
 *
 * @returns {Error} The carrier for the quiet response.
 */
function quietShareLimit() {
  const error = new Error('share rate limit reached');
  error.statusCode = 200;
  error.code = 'SHARE_NOT_ELIGIBLE';
  error.quietResponse = { eligible: false };
  error.quietStatusCode = 200;
  return error;
}

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @param {{ config: object }} options Plugin options.
 * @returns {Promise<void>} Resolves when registered.
 */
async function rateLimitPlugin(fastify, options) {
  const { config } = options;

  if (config.rateLimit.redisUrl) {
    fastify.log.warn(
      'RATE_LIMIT_REDIS_URL is configured but the in-memory store is in use; limits are per node.',
    );
  }

  await fastify.register(rateLimit, {
    // Limits are attached per route from `fastify.rateLimits`; nothing is limited by
    // accident, and nothing important is limited by omission.
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: ipKey,
    errorResponseBuilder: limitError,
    // The reading path must never be throttled by a shared upstream cache key.
    enableDraftSpec: false,
  });

  /**
   * Named budgets. Attach with `config: { rateLimit: fastify.rateLimits.<name> }`.
   */
  const budgets = Object.freeze({
    /** `POST /sessions` — 10 per hour per address (§9.6). */
    sessionCreate: Object.freeze({
      max: 10,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    /** `POST /events` — 60 batches per minute per session. Fire-and-forget either way. */
    eventIngest: Object.freeze({
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    /** `POST /shares` — 5 per day per session, failing quietly. */
    shareCreate: Object.freeze({
      max: 5,
      timeWindow: '1 day',
      keyGenerator: sessionKey,
      addHeaders: SILENT_HEADERS,
      addHeadersOnExceeding: SILENT_HEADERS,
      errorResponseBuilder: quietShareLimit,
    }),

    /** Donation and order attempts — 10 per hour per session (§9.6). */
    commerceAttempt: Object.freeze({
      max: 10,
      timeWindow: '1 hour',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    /** `POST /admin/auth/login` — 5 per 15 minutes, then a widening ban. */
    adminLogin: Object.freeze({
      max: 5,
      timeWindow: '15 minutes',
      ban: 5,
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
      /**
       * A ban is an alertable security signal (§9.6). The key is an address, so it is
       * deliberately absent from the log record.
       */
      onBanReach() {
        fastify.log.warn(
          { alert: 'admin_login_ban' },
          'repeated failed admin sign-in attempts triggered a temporary ban',
        );
      },
    }),

    /**
     * Public token lookups — `GET /shares/:token`, `GET /transcript/:accessToken`,
     * `GET /commerce/receipts/:receiptNumber`. Guessing an opaque token should be
     * expensive; a legitimate reader opens one link.
     */
    publicTokenLookup: Object.freeze({
      max: 60,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    /**
     * `POST /feedback` — 20 per hour per session. Generous enough that a reader who marked
     * several passages can comment on each of them in one sitting, tight enough that the
     * review queue cannot be flooded from one session. This limit is *not* silent: unlike a
     * share, a lost submission costs the reader something they wrote.
     */
    feedbackCreate: Object.freeze({
      max: 20,
      timeWindow: '1 hour',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    /** Reading-path reads: generous, present only to blunt a scraper. */
    readingPath: Object.freeze({
      max: 600,
      timeWindow: '1 minute',
      keyGenerator: sessionKey,
      errorResponseBuilder: limitError,
    }),

    /** Anything that sends mail on a reader's behalf (family withdrawal, welcome resend). */
    mailTrigger: Object.freeze({
      max: 5,
      timeWindow: '1 hour',
      keyGenerator: ipKey,
      errorResponseBuilder: limitError,
    }),

    /**
     * Administrator-triggered outbound mail — bulk invitation send, and per-row resend.
     * §10.10.1 requires the admin namespace to carry its own limits; this is the one that
     * matters, because it is the only admin route whose effect leaves the building.
     *
     * `mailTrigger` cannot be reused here. It is 5 per hour keyed by address, sized for a
     * reader triggering their own welcome mail, and a coordinator sending one batch and then
     * chasing a few bounces would exhaust it in a minute.
     *
     * 30 per hour, per administrator. The unit is the *request*, not the address: one call
     * carrying 200 invitations costs one. So this does not cap how many readers can be
     * invited — it caps how many times the button can be pressed, which is the accident being
     * guarded against. A double-submitted batch is not recoverable; mail that has left cannot
     * be recalled, and an invitation arriving twice reads as carelessness to precisely the
     * people being asked to trust the work.
     */
    adminBulkSend: Object.freeze({
      max: 30,
      timeWindow: '1 hour',
      keyGenerator: adminTokenKey,
      errorResponseBuilder: limitError,
    }),

    /**
     * Every other admin route. Deliberately generous — this is not a defence against an
     * authenticated operator, who is trusted and has a slow human hand on the keyboard. It
     * exists so a leaked token cannot be used to enumerate readers at machine speed, and so
     * a looping screen cannot take the API down on its own.
     */
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
