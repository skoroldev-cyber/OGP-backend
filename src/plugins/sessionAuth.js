import { COLLECTIONS } from '../db/collections.js';
import { bearerFromHeader, hashSessionToken } from '../lib/tokens.js';

const SESSION_PROJECTION = Object.freeze({ tokenHash: 0 });

function sessionRequired() {
  const error = new Error('A reading session is required for this request.');
  error.statusCode = 401;
  error.code = 'SESSION_REQUIRED';
  error.expose = true;
  return error;
}

async function sessionAuthPlugin(fastify) {
  fastify.decorateRequest('session', null);

  async function resolveSession(request) {
    const token = bearerFromHeader(request.headers.authorization);
    if (token === null) return null;

    const tokenHash = hashSessionToken(token);
    const session = await fastify.db
      .collection(COLLECTIONS.READING_SESSIONS)
      .findOne({ tokenHash }, { projection: SESSION_PROJECTION });

    if (session === null) return null;
    if (session.expiresAt instanceof Date && session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return session;
  }

  fastify.decorate('resolveSession', resolveSession);

  fastify.decorate('requireSession', async function requireSession(request) {
    const session = await resolveSession(request);
    if (session === null) throw sessionRequired();
    request.session = session;
  });

  fastify.decorate('optionalSession', async function optionalSession(request) {
    request.session = await resolveSession(request);
  });
}

sessionAuthPlugin[Symbol.for('skip-override')] = true;
sessionAuthPlugin[Symbol.for('fastify.display-name')] = 'ogp-session-auth';

export default sessionAuthPlugin;
