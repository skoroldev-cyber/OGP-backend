import { COLLECTIONS } from '../../db/collections.js';
import { toPaging } from '../../lib/schemas.js';
import { toIso, toJsonText } from './schemas.js';

const COUNTED_COLLECTIONS = Object.freeze([
  COLLECTIONS.READING_SESSIONS,
  COLLECTIONS.EVENTS,
  COLLECTIONS.MANUSCRIPT_UNITS,
  COLLECTIONS.SHARE_TOKENS,
  COLLECTIONS.INVITATIONS,
  COLLECTIONS.QUESTIONNAIRE_RESPONSES,
  COLLECTIONS.FEEDBACK,
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.DIGITAL_ACCESS_GRANTS,
  COLLECTIONS.NMI_WEBHOOK_EVENTS,
  COLLECTIONS.AUDIT_LOG,
]);

export function createAdminOpsService({ db, config, logger = null, mongoReady = null }) {
  const auditLog = db.collection(COLLECTIONS.AUDIT_LOG);

  return {
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
        gateway: { mode: config.nmi.mock === true ? 'mock' : 'live' },
        counts,
      };
    },

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

      const { limit, skip } = toPaging(query);
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
