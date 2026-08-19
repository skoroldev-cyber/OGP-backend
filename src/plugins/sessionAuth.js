/**
 * Anonymous reader authentication.
 *
 * `POST /sessions` mints 256 bits of randomness and returns it once. The server keeps only
 * the SHA-256 hash. There is no account, no password, no email, no OAuth — the token *is*
 * the session, and `DELETE /sessions/current` erases it.
 *
 * Two preHandlers are decorated:
 *   `requireSession`  — 401 `SESSION_REQUIRED` when no valid session is presented.
 *   `optionalSession` — attaches `request.session` when one is presented, otherwise null.
 *
 * A missing token, an unknown token and an expired token all produce the same 401 with the
 * same code. Distinguishing them would let an attacker probe which opaque strings exist.
 *
 * `request.session` never carries `tokenHash`: nothing downstream needs it, and excluding
 * it means a careless response serialisation cannot leak the lookup key.
 */

import { COLLECTIONS } from '../db/collections.js';
import { bearerFromHeader, hashSessionToken } from '../lib/tokens.js';

/** Everything except the lookup key. */
const SESSION_PROJECTION = Object.freeze({ tokenHash: 0 });

function sessionRequired() {
  const error = new Error('A reading session is required for this request.');
  error.statusCode = 401;
  error.code = 'SESSION_REQUIRED';
  error.expose = true;
  return error;
}

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @returns {Promise<void>} Resolves when registered.
 */
async function sessionAuthPlugin(fastify) {
  // Declared up front so the shape of every request object stays monomorphic.
  fastify.decorateRequest('session', null);

  /**
   * Resolve the session behind a request, without deciding what to do about its absence.
   *
   * @param {import('fastify').FastifyRequest} request The request.
   * @returns {Promise<object|null>} The session document, or null.
   */
  async function resolveSession(request) {
    const token = bearerFromHeader(request.headers.authorization);
    if (token === null) return null;

    const tokenHash = hashSessionToken(token);
    const session = await fastify.db
      .collection(COLLECTIONS.READING_SESSIONS)
      .findOne({ tokenHash }, { projection: SESSION_PROJECTION });

    if (session === null) return null;
    // The TTL monitor runs about once a minute, so an expired document can still be read.
    // Treat it as gone the instant it expires.
    if (session.expiresAt instanceof Date && session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return session;
  }

  fastify.decorate('resolveSession', resolveSession);

  /**
   * preHandler for every **S**-authenticated route.
   *
   * @param {import('fastify').FastifyRequest} request The request.
   * @returns {Promise<void>} Resolves when the session is attached.
   */
  fastify.decorate('requireSession', async function requireSession(request) {
    const session = await resolveSession(request);
    if (session === null) throw sessionRequired();
    request.session = session;
  });

  /**
   * preHandler for routes that behave differently with a session but do not demand one.
   *
   * @param {import('fastify').FastifyRequest} request The request.
   * @returns {Promise<void>} Always resolves.
   */
  fastify.decorate('optionalSession', async function optionalSession(request) {
    request.session = await resolveSession(request);
  });
}

sessionAuthPlugin[Symbol.for('skip-override')] = true;
sessionAuthPlugin[Symbol.for('fastify.display-name')] = 'ogp-session-auth';

export default sessionAuthPlugin;
