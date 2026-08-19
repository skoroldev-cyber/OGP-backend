/**
 * Operations — health detail and the audit log.
 *
 * `GET /admin/health/detail` is the authenticated counterpart to the public `/healthz`,
 * which discloses liveness and nothing else. Even here nothing sensitive is reported: the
 * gateway is described as live or mocked, never by key, key fingerprint or endpoint, and no
 * secret, connection string or version string appears in the response.
 *
 * The audit log is **read-only for every role, including the founder**. There is no update
 * path and no delete path anywhere in the codebase — `db/collections.js` lists it as
 * append-only and this module offers reading alone. Nobody edits history.
 */

import { COLLECTIONS } from '../../db/collections.js';
import { toIso, toJsonText } from './schemas.js';

/**
 * Collections worth counting on a health page: the ones whose growth or silence says
 * something operational. Counting every collection would be a round trip each, to say less.
 */
const COUNTED_COLLECTIONS = Object.freeze([
  COLLECTIONS.READING_SESSIONS,
  COLLECTIONS.EVENTS,
  COLLECTIONS.MANUSCRIPT_UNITS,
  COLLECTIONS.SHARE_TOKENS,
  COLLECTIONS.INVITATIONS,
  COLLECTIONS.QUESTIONNAIRE_RESPONSES,
  // A review queue nobody is working is an operational fact worth seeing.
  COLLECTIONS.FEEDBACK,
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.DIGITAL_ACCESS_GRANTS,
  COLLECTIONS.NMI_WEBHOOK_EVENTS,
  COLLECTIONS.AUDIT_LOG,
]);

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object,
 *           mongoReady?: Function }} deps Dependencies. `mongoReady` is the bounded probe
 *        decorated by `plugins/mongo.js`; it is passed in so this service never imports
 *        Fastify.
 * @returns {object} The admin ops service.
 */
export function createAdminOpsService({ db, config, logger = null, mongoReady = null }) {
  const auditLog = db.collection(COLLECTIONS.AUDIT_LOG);

  return {
    /**
     * `GET /admin/health/detail`.
     *
     * @returns {Promise<object>} The health report.
     */
    async healthDetail() {
      const database = mongoReady
        ? await mongoReady()
        : await (async () => {
            const started = Date.now();
            try {
              await db.command({ ping: 1 });
              return { ok: true, latencyMs: Date.now() - started };
            } catch {
              return { ok: false, latencyMs: null };
            }
          })();

      const counts = [];
      for (const collectionName of COUNTED_COLLECTIONS) {
        try {
          counts.push({
            collection: collectionName,
            documents: await db.collection(collectionName).estimatedDocumentCount(),
          });
        } catch (error) {
          logger?.warn?.(
            { collection: collectionName, reason: error?.codeName },
            'collection count unavailable for the health report',
          );
        }
      }

      return {
        status: database.ok ? 'ok' : 'degraded',
        environment: config.env,
        database: { ok: database.ok === true, latencyMs: database.latencyMs ?? null },
        flags: {
          ageLayerEnabled: config.flags.ageLayerEnabled === true,
          freeAccessEnabled: config.flags.freeAccessEnabled === true,
          hardcoverPurchasable: config.flags.hardcoverPurchasable === true,
          sharingEnabled: config.flags.sharingEnabled === true,
        },
        mail: { transport: config.mail.transport },
        // Live or mocked. Nothing that identifies the credential behind it.
        gateway: { mode: config.nmi.mock === true ? 'mock' : 'live' },
        counts,
      };
    },

    /**
     * `GET /admin/audit?target=`.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<{ entries: object[], total: number }>} The trail, newest first.
     */
    async listAudit(query = {}) {
      const filter = {};
      if (query.target) filter.targetCollection = query.target;
      if (query.targetId) filter.targetId = query.targetId;
      if (query.action) filter.action = query.action;
      if (query.actorId) filter.actorId = query.actorId;
      if (query.from || query.to) {
        filter.at = {};
        if (query.from) filter.at.$gte = new Date(query.from);
        if (query.to) filter.at.$lte = new Date(query.to);
      }

      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        auditLog.find(filter, { sort: { at: -1 }, limit, skip }).toArray(),
        auditLog.countDocuments(filter),
      ]);

      return {
        entries: documents.map((entry) => ({
          id: entry._id,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          targetCollection: entry.targetCollection ?? null,
          targetId: entry.targetId ?? null,
          correlationId: entry.correlationId ?? null,
          // Diffs were redacted on the way in by `lib/audit.js`; they are rendered as text
          // so the response envelope can stay closed.
          before: toJsonText(entry.before),
          after: toJsonText(entry.after),
          at: toIso(entry.at),
        })),
        total: count,
      };
    },
  };
}

export default createAdminOpsService;
