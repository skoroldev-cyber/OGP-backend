/**
 * Admin authentication and role enforcement.
 *
 * Admins present a short-lived HS256 access token (`lib/jwt.js`). The token is verified,
 * then the account is re-read: a token issued minutes ago must not outlive a deactivated
 * account or a role change. That database read is deliberate — admin routes are cold, and
 * correctness beats a saved round trip here.
 *
 * MFA is mandatory (§9.2.10). The login route proves password *and* TOTP before a token is
 * ever issued; this plugin additionally refuses a token whose account has no confirmed MFA
 * enrolment, so a credential created by a script cannot be used until MFA is set up.
 *
 * Usage: `{ preHandler: fastify.requireAdmin(['founder', 'editor']) }`.
 * An empty or omitted role list means "any active admin".
 */

import { COLLECTIONS } from '../db/collections.js';
import { ADMIN_ROLES } from '../config/constants.js';
import { bearerFromHeader } from '../lib/tokens.js';
import { verifyJwt } from '../lib/jwt.js';

/** Access tokens carry this issuer and audience; a refresh token carries a different type. */
export const ADMIN_JWT_ISSUER = 'ogp';
export const ADMIN_JWT_AUDIENCE = 'ogp-admin';
export const ADMIN_ACCESS_TOKEN_TYPE = 'access';

/** Everything the admin routes need, and nothing a credential lives in. */
const ADMIN_PROJECTION = Object.freeze({
  passwordHash: 0,
  refreshTokenHash: 0,
  'mfa.totpSecretEnc': 0,
});

function adminAuthRequired() {
  const error = new Error('Administrator authentication is required.');
  error.statusCode = 401;
  error.code = 'ADMIN_AUTH_REQUIRED';
  error.expose = true;
  return error;
}

/** Matches the synthetic subject minted by the development sign-in in modules/admin/auth.js. */
const DEV_ADMIN_ID = 'dev-local-gate';

function forbidden() {
  const error = new Error('This account does not hold the role required for this action.');
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  error.expose = true;
  return error;
}

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @param {{ config: object }} options Plugin options.
 * @returns {Promise<void>} Resolves when registered.
 */
async function adminAuthPlugin(fastify, options) {
  const { config } = options;

  fastify.decorateRequest('admin', null);

  /**
   * Verify a token and load the account behind it.
   *
   * @param {import('fastify').FastifyRequest} request The request.
   * @returns {Promise<object>} The admin document.
   * @throws {Error} 401 when the token or the account is unusable.
   */
  async function resolveAdmin(request) {
    const token = bearerFromHeader(request.headers.authorization);
    if (token === null) throw adminAuthRequired();

    let claims;
    try {
      claims = verifyJwt(token, {
        secret: config.secrets.adminJwt,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      });
    } catch (error) {
      request.log.warn({ reason: error.code }, 'admin token rejected');
      throw adminAuthRequired();
    }

    if (claims.typ !== ADMIN_ACCESS_TOKEN_TYPE || typeof claims.sub !== 'string') {
      throw adminAuthRequired();
    }

    // The development sign-in has no account record to load, by design — it exists precisely
    // so the panel is usable before accounts exist. The token is still a real, signed,
    // expiring token verified above; what is skipped is only the database lookup, because
    // there is nothing to look up.
    //
    // `config.adminDevLogin.enabled` is already false whenever NODE_ENV=production, so a
    // production build cannot reach this branch even if a token from elsewhere carried the
    // synthetic subject.
    if (config.adminDevLogin?.enabled && claims.sub === DEV_ADMIN_ID) {
      return { _id: DEV_ADMIN_ID, email: config.adminDevLogin.name, role: 'founder', active: true };
    }

    const admin = await fastify.db
      .collection(COLLECTIONS.ADMIN_USERS)
      .findOne({ _id: claims.sub }, { projection: ADMIN_PROJECTION });

    if (admin === null || admin.active !== true) throw adminAuthRequired();
    if (admin.mfa?.enabled !== true) {
      request.log.warn({ adminId: admin._id }, 'admin token presented for an account without MFA');
      throw adminAuthRequired();
    }
    // A role change invalidates a token issued under the old role.
    if (typeof claims.role === 'string' && claims.role !== admin.role) throw adminAuthRequired();

    return admin;
  }

  fastify.decorate('resolveAdmin', resolveAdmin);

  /**
   * Build a preHandler enforcing membership in a role set.
   *
   * @param {string[]} [roles] Allowed roles. Empty means any active admin.
   * @returns {Function} A Fastify preHandler.
   */
  fastify.decorate('requireAdmin', function requireAdmin(roles = []) {
    if (!Array.isArray(roles)) {
      throw new TypeError('requireAdmin: roles must be an array.');
    }
    for (const role of roles) {
      if (!ADMIN_ROLES.includes(role)) {
        throw new TypeError(`requireAdmin: "${role}" is not a known admin role.`);
      }
    }
    const allowed = new Set(roles);

    return async function adminPreHandler(request) {
      const admin = await resolveAdmin(request);
      if (allowed.size > 0 && !allowed.has(admin.role)) {
        request.log.warn(
          { adminId: admin._id, role: admin.role, route: request.routeOptions?.url },
          'admin role check failed',
        );
        throw forbidden();
      }
      request.admin = admin;
    };
  });
}

adminAuthPlugin[Symbol.for('skip-override')] = true;
adminAuthPlugin[Symbol.for('fastify.display-name')] = 'ogp-admin-auth';

export default adminAuthPlugin;
