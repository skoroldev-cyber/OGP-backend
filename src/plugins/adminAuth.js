import { COLLECTIONS } from '../db/collections.js';
import { ADMIN_ROLES } from '../config/constants.js';
import { bearerFromHeader } from '../lib/tokens.js';
import { verifyJwt } from '../lib/jwt.js';

export const ADMIN_JWT_ISSUER = 'ogp';
export const ADMIN_JWT_AUDIENCE = 'ogp-admin';
export const ADMIN_ACCESS_TOKEN_TYPE = 'access';

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

const DEV_ADMIN_ID = 'dev-local-gate';

function forbidden() {
  const error = new Error('This account does not hold the role required for this action.');
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  error.expose = true;
  return error;
}

async function adminAuthPlugin(fastify, options) {
  const { config } = options;

  fastify.decorateRequest('admin', null);

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
    if (typeof claims.role === 'string' && claims.role !== admin.role) throw adminAuthRequired();

    return admin;
  }

  fastify.decorate('resolveAdmin', resolveAdmin);

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
