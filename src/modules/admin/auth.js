import { COLLECTIONS, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit, writeAuditSafe } from '../../lib/audit.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/hash.js';
import { opaqueToken } from '../../lib/ids.js';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC, signJwt } from '../../lib/jwt.js';
import { hashSessionToken } from '../../lib/tokens.js';
import { verifyTotp } from '../../lib/totp.js';
import {
  ADMIN_ACCESS_TOKEN_TYPE,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from '../../plugins/adminAuth.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

const DEV_ADMIN_ID = 'dev-local-gate';

function devLoginMatches(config, input) {
  const gate = config.adminDevLogin;
  if (!gate?.enabled || config.env === 'production') return false;
  const name = String(input.email ?? '').trim().toLowerCase();
  return name === gate.name && input.password === gate.password;
}

const REFRESH_TOKEN_LENGTH = 48;

const MAX_FAILED_LOGINS = 5;

const LOCKOUT_BASE_MS = 15 * 60 * 1000;
const LOCKOUT_CEILING_MS = 4 * 60 * 60 * 1000;

function credentialsRejected() {
  return new ApiError(401, 'ADMIN_AUTH_FAILED', 'Those credentials were not accepted.');
}

function lockoutMs(failures) {
  const excess = Math.max(failures - MAX_FAILED_LOGINS, 0);
  return Math.min(LOCKOUT_BASE_MS * 2 ** excess, LOCKOUT_CEILING_MS);
}

export function toAdminSummary(admin) {
  return {
    id: admin._id,
    email: admin.email,
    displayName: admin.displayName ?? null,
    role: admin.role,
    active: admin.active === true,
    lastLoginAt: toIso(admin.lastLoginAt),
  };
}

export function createAdminAuthService({ db, config, logger = null, verifyTotpFn = null }) {
  const admins = db.collection(COLLECTIONS.ADMIN_USERS);

  async function issueSession(admin, now) {
    const access = signJwt(
      { role: admin.role, typ: ADMIN_ACCESS_TOKEN_TYPE },
      {
        secret: config.secrets.adminJwt,
        expiresInSec: ACCESS_TOKEN_TTL_SEC,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
        subject: admin._id,
        now: now.getTime(),
      },
    );

    const refreshToken = opaqueToken(REFRESH_TOKEN_LENGTH);
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000);
    // Local-gate admin is not a database record. Persist nothing so sign-in still
    // works when Mongo is unreachable (e.g. Atlas has not allowlisted this host).
    if (admin._id !== DEV_ADMIN_ID) {
      await admins.updateOne(
        { _id: admin._id },
        {
          $set: {
            refreshTokenHash: hashSessionToken(refreshToken),
            refreshTokenExpiresAt,
            lastLoginAt: now,
            failedLoginCount: 0,
            lockedUntil: null,
            ...updateStamps(now),
          },
        },
      );
    }

    return {
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
      refreshToken,
      admin: toAdminSummary({ ...admin, lastLoginAt: now }),
    };
  }

  async function recordFailure(admin, reason, options) {
    const now = new Date();
    if (admin) {
      const failures = (Number(admin.failedLoginCount) || 0) + 1;
      const update = { failedLoginCount: failures, ...updateStamps(now) };
      if (failures >= MAX_FAILED_LOGINS) {
        update.lockedUntil = new Date(now.getTime() + lockoutMs(failures));
        logger?.warn?.(
          { alert: 'admin_account_locked', adminId: admin._id, failures },
          'an administrator account was locked after repeated failed sign-ins',
        );
      }
      await admins.updateOne({ _id: admin._id }, { $set: update });
    }

    await writeAuditSafe(
      db,
      {
        actorType: 'system',
        action: AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
        targetCollection: COLLECTIONS.ADMIN_USERS,
        targetId: admin?._id ?? null,
        after: { reason },
        correlationId: options?.correlationId ?? null,
      },
      logger,
    );
  }

  return {
    async login(input, options = {}) {
      const now = new Date();
      const address = input.email.trim().toLowerCase();

      if (devLoginMatches(config, input)) {
        logger?.warn(
          { name: address },
          'development sign-in used — no second factor, no account record. Never production.',
        );
        return issueSession(
          {
            _id: DEV_ADMIN_ID,
            email: address,
            role: 'founder',
            active: true,
          },
          now,
        );
      }

      const admin = await admins.findOne({ email: address });

      if (!admin || admin.active !== true) {
        await verifyPassword(input.password, 'scrypt$32768$8$1$AAAA$AAAA');
        await recordFailure(null, admin ? 'inactive_account' : 'unknown_account', options);
        throw credentialsRejected();
      }

      if (admin.lockedUntil instanceof Date && admin.lockedUntil.getTime() > now.getTime()) {
        await recordFailure(admin, 'locked', options);
        throw credentialsRejected();
      }

      const passwordOk = await verifyPassword(input.password, admin.passwordHash);
      if (!passwordOk) {
        await recordFailure(admin, 'bad_password', options);
        throw credentialsRejected();
      }

      const secret = admin.mfa?.totpSecretEnc;
      if (admin.mfa?.enabled !== true || typeof secret !== 'string' || secret === '') {
        await recordFailure(admin, 'mfa_not_enrolled', options);
        throw credentialsRejected();
      }

      const verify = verifyTotpFn ?? verifyTotp;
      if (verify(secret, input.totpCode, { timestamp: now.getTime() }).valid !== true) {
        await recordFailure(admin, 'bad_totp', options);
        throw credentialsRejected();
      }

      if (needsRehash(admin.passwordHash)) {
        try {
          const rehashed = await hashPassword(input.password);
          await admins.updateOne(
            { _id: admin._id },
            { $set: { passwordHash: rehashed, ...updateStamps(now) } },
          );
        } catch (error) {
          logger?.warn?.({ err: error, adminId: admin._id }, 'password rehash skipped');
        }
      }

      const session = await issueSession(admin, now);

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.ADMIN_LOGIN,
        targetCollection: COLLECTIONS.ADMIN_USERS,
        targetId: admin._id,
        after: { role: admin.role },
        correlationId: options.correlationId ?? null,
      });

      return session;
    },

    async refresh(input, options = {}) {
      const now = new Date();
      const admin = await admins.findOne({
        refreshTokenHash: hashSessionToken(input.refreshToken),
        active: true,
      });

      if (
        !admin ||
        !(admin.refreshTokenExpiresAt instanceof Date) ||
        admin.refreshTokenExpiresAt.getTime() <= now.getTime()
      ) {
        logger?.warn?.({ alert: 'admin_refresh_rejected' }, 'an admin refresh token was rejected');
        throw credentialsRejected();
      }
      if (admin.mfa?.enabled !== true) throw credentialsRejected();

      const session = await issueSession(admin, now);
      await writeAuditSafe(
        db,
        {
          actorType: 'admin',
          actorId: admin._id,
          action: AUDIT_ACTIONS.ADMIN_LOGIN,
          targetCollection: COLLECTIONS.ADMIN_USERS,
          targetId: admin._id,
          after: { rotated: true },
          correlationId: options.correlationId ?? null,
        },
        logger,
      );
      return session;
    },

    async logout(admin, options = {}) {
      if (admin._id === DEV_ADMIN_ID) return;

      const now = new Date();
      await admins.updateOne(
        { _id: admin._id },
        {
          $set: { refreshTokenHash: null, refreshTokenExpiresAt: null, ...updateStamps(now) },
        },
      );
      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.ADMIN_LOGOUT,
        targetCollection: COLLECTIONS.ADMIN_USERS,
        targetId: admin._id,
        correlationId: options.correlationId ?? null,
      });
    },
  };
}

export default createAdminAuthService;
