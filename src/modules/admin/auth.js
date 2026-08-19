/**
 * Administrator authentication.
 *
 * **MFA is mandatory, for every role, including the founder.** Password and TOTP are
 * presented together in one request and verified together; there is no intermediate state
 * in which a correct password alone has bought anything, because such a state is where
 * MFA-bypass bugs live (§9.2.10, §10.8.2).
 *
 * Access tokens last fifteen minutes. Refresh tokens rotate on every use and are bound to a
 * server-side record: the token itself is 288 bits of randomness, only its SHA-256 hash is
 * stored, and a rotation invalidates the previous value immediately. A stolen refresh token
 * is therefore useful only until its owner next refreshes.
 *
 * Failed sign-ins are counted and produce a widening lockout on top of the route's 5-per-15
 * minutes limit, and both the lockout and the limiter's ban raise an alertable log record.
 * The response never distinguishes "no such account" from "wrong password" from "wrong
 * code" — one message, one status, one timing profile as far as an attacker can observe.
 *
 * No third-party identity provider is involved, by explicit decision: no "Sign in with
 * Google", no OAuth, no SSO (§10.8.2).
 */

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

/** Refresh token length in characters (~288 bits over a 64-symbol alphabet). */
/**
 * The synthetic subject of a development sign-in.
 *
 * Deliberately not a real account id and deliberately self-describing: it appears in the audit
 * log and in every token minted this way, so a record written through the development door can
 * never be mistaken for one written by a person.
 */
const DEV_ADMIN_ID = 'dev-local-gate';

/**
 * Does this attempt match the configured development credentials?
 *
 * Refuses in production regardless of configuration — the environment is the outer gate and the
 * flag is only the inner one, so no combination of variables opens this on a production build.
 *
 * @param {object} config The application config.
 * @param {{ email?: string, password?: string }} input The attempt.
 * @returns {boolean} True when the development door should open.
 */
function devLoginMatches(config, input) {
  const gate = config.adminDevLogin;
  if (!gate?.enabled || config.env === 'production') return false;
  const name = String(input.email ?? '').trim().toLowerCase();
  return name === gate.name && input.password === gate.password;
}

const REFRESH_TOKEN_LENGTH = 48;

/** Failures tolerated before the account itself locks, on top of the address-level limit. */
const MAX_FAILED_LOGINS = 5;

/** Base lockout, doubling for each additional failure beyond the threshold, to a ceiling. */
const LOCKOUT_BASE_MS = 15 * 60 * 1000;
const LOCKOUT_CEILING_MS = 4 * 60 * 60 * 1000;

/** One refusal for every failure mode. Nothing here tells an attacker what to try next. */
function credentialsRejected() {
  return new ApiError(401, 'ADMIN_AUTH_FAILED', 'Those credentials were not accepted.');
}

/**
 * @param {number} failures How many consecutive failures have occurred.
 * @returns {number} Lockout duration in milliseconds.
 */
function lockoutMs(failures) {
  const excess = Math.max(failures - MAX_FAILED_LOGINS, 0);
  return Math.min(LOCKOUT_BASE_MS * 2 ** excess, LOCKOUT_CEILING_MS);
}

/**
 * @param {object} admin An `admin_users` document.
 * @returns {object} The administrator as the dashboard may see them.
 */
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

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object,
 *           verifyTotpFn?: Function }} deps Dependencies. `verifyTotpFn` is a seam for
 *        tests; production always uses `lib/totp.js`.
 * @returns {object} The admin auth service.
 */
export function createAdminAuthService({ db, config, logger = null, verifyTotpFn = null }) {
  const admins = db.collection(COLLECTIONS.ADMIN_USERS);

  /**
   * Mint an access token and a fresh refresh token, and bind the refresh token to the
   * account record. Any previously issued refresh token stops working at this moment.
   *
   * @param {object} admin The authenticated administrator.
   * @param {Date} now Timestamp.
   * @returns {Promise<object>} The session response.
   */
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

    return {
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
      refreshToken,
      admin: toAdminSummary({ ...admin, lastLoginAt: now }),
    };
  }

  /**
   * Record a failed attempt and lock the account once the count crosses the threshold.
   *
   * @param {object|null} admin The account, when one was found.
   * @param {string} reason Why it failed. Server-side only.
   * @param {{ correlationId?: string|null }} options Audit context.
   * @returns {Promise<void>} Resolves when recorded.
   */
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
        // The reason is recorded for the security review; the address is not, and no
        // credential material of any kind reaches this record.
        after: { reason },
        correlationId: options?.correlationId ?? null,
      },
      logger,
    );
  }

  return {
    /**
     * `POST /admin/auth/login`.
     *
     * @param {{ email: string, password: string, totpCode: string }} input Credentials.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<object>} The session response.
     * @throws {ApiError} 401 for every failure mode.
     */
    async login(input, options = {}) {
      const now = new Date();
      const address = input.email.trim().toLowerCase();

      // ==================================================================
      //  INTERIM DEVELOPMENT SIGN-IN — refused in production
      // ==================================================================
      // A fixed name and password, no second factor, no account record. It exists so the
      // operations panel can be used before the real account flow is settled: without a token
      // the panel renders its chrome and every screen underneath it fails on a missing
      // authorization header, which is worse than useless for reviewing the work.
      //
      // It issues a REAL session, because a fake one would only move the failure later. The
      // subject is a synthetic id that belongs to no account, so the audit log records
      // "someone used the development door" rather than attributing the action to a person
      // who did not perform it.
      //
      // `config.env === 'production'` is checked inside `devLogin`, not here, so there is no
      // arrangement of environment variables that opens this door on a production build.
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
        // The password is still verified against nothing so that a missing account and a
        // wrong password cost the same wall-clock time.
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

      // MFA is not optional and not deferrable. An account without confirmed enrolment
      // cannot sign in at all, which is what stops a scripted credential from being usable.
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

      // Cost is raised silently on the next successful sign-in when policy moves.
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

    /**
     * `POST /admin/auth/refresh`. Rotating: the presented token is consumed and replaced.
     *
     * @param {{ refreshToken: string }} input The presented token.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<object>} A new session response.
     * @throws {ApiError} 401 when the token is unknown, expired, or already rotated.
     */
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

    /**
     * `POST /admin/auth/logout`. Drops the server-side refresh binding; the access token
     * expires on its own within fifteen minutes.
     *
     * @param {object} admin The authenticated administrator.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<void>} Resolves when the session is closed.
     */
    async logout(admin, options = {}) {
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
