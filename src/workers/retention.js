import { COLLECTIONS } from '../db/collections.js';

export const RETENTION_PERIODS = Object.freeze({
  readingSessionDays: 400,
  rawEventMonths: 24,
  commerceYears: 7,
  auditYears: 7,
});

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DELETE_CHUNK = 5000;

const MS_PER_DAY = 86_400_000;

function daysAgo(days, now) {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

function monthsAgo(months, now) {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

function yearsAgo(years, now) {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff;
}

async function defaultSink(rollups, { logger }) {
  for (const rollup of rollups) {
    logger?.info?.({ rollup }, 'event rollup before deletion');
  }
}

async function deleteInChunks(collection, filter) {
  let deleted = 0;
  for (;;) {
    const ids = await collection
      .find(filter, { projection: { _id: 1 }, limit: DELETE_CHUNK })
      .toArray();
    if (ids.length === 0) break;
    const result = await collection.deleteMany({ _id: { $in: ids.map((row) => row._id) } });
    deleted += result.deletedCount ?? 0;
    if (ids.length < DELETE_CHUNK) break;
  }
  return deleted;
}

export async function sweepExpiredSessions(db, options = {}) {
  const { now = new Date(), days = RETENTION_PERIODS.readingSessionDays } = options;
  const idleCutoff = daysAgo(days, now);
  const deleted = await deleteInChunks(db.collection(COLLECTIONS.READING_SESSIONS), {
    $or: [
      { expiresAt: { $lte: now } },
      { expiresAt: null, 'progress.lastReadAt': { $lt: idleCutoff } },
    ],
  });
  return { deleted };
}

export async function aggregateEventsBefore(db, { before }) {
  return db
    .collection(COLLECTIONS.EVENTS)
    .aggregate(
      [
        { $match: { receivedAt: { $lt: before } } },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
              name: '$name',
              contentLayer: '$contentLayer',
            },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            day: '$_id.day',
            name: '$_id.name',
            contentLayer: '$_id.contentLayer',
            count: 1,
          },
        },
        { $sort: { day: 1, name: 1 } },
      ],
      { allowDiskUse: true },
    )
    .toArray();
}

export async function runEventRetention(db, options = {}) {
  const {
    now = new Date(),
    months = RETENTION_PERIODS.rawEventMonths,
    sink = defaultSink,
    logger = null,
  } = options;

  const cutoff = monthsAgo(months, now);
  const rollups = await aggregateEventsBefore(db, { before: cutoff });
  if (rollups.length === 0) {
    return { cutoff: cutoff.toISOString(), buckets: 0, deleted: 0 };
  }

  await sink(rollups, { logger, cutoff });

  const deleted = await deleteInChunks(db.collection(COLLECTIONS.EVENTS), {
    receivedAt: { $lt: cutoff },
  });
  return { cutoff: cutoff.toISOString(), buckets: rollups.length, deleted };
}

export async function reportLongTermRetention(db, options = {}) {
  const { now = new Date(), periods = RETENTION_PERIODS } = options;
  const commerceCutoff = yearsAgo(periods.commerceYears, now);
  const auditCutoff = yearsAgo(periods.auditYears, now);

  const [donations, orders, payments, audit] = await Promise.all([
    db.collection(COLLECTIONS.DONATIONS).countDocuments({ createdAt: { $lt: commerceCutoff } }),
    db.collection(COLLECTIONS.ORDERS).countDocuments({ createdAt: { $lt: commerceCutoff } }),
    db
      .collection(COLLECTIONS.PAYMENT_TRANSACTIONS)
      .countDocuments({ createdAt: { $lt: commerceCutoff } }),
    db.collection(COLLECTIONS.AUDIT_LOG).countDocuments({ at: { $lt: auditCutoff } }),
  ]);

  return {
    commerceCutoff: commerceCutoff.toISOString(),
    auditCutoff: auditCutoff.toISOString(),
    dueForReview: { donations, orders, paymentTransactions: payments, auditLog: audit },
  };
}

export function createRetentionWorker({
  db,
  logger = null,
  periods = RETENTION_PERIODS,
  sink = defaultSink,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  if (!db) throw new TypeError('createRetentionWorker: a database handle is required.');
  let timer = null;
  let running = false;

  async function runOnce({ now = new Date() } = {}) {
    if (running) return { skipped: true };
    running = true;
    try {
      const sessions = await sweepExpiredSessions(db, {
        now,
        days: periods.readingSessionDays,
      });
      const events = await runEventRetention(db, {
        now,
        months: periods.rawEventMonths,
        sink,
        logger,
      });
      const longTerm = await reportLongTermRetention(db, { now, periods });

      logger?.info?.(
        {
          sessionsDeleted: sessions.deleted,
          eventsDeleted: events.deleted,
          eventBuckets: events.buckets,
          sessionRetentionDays: periods.readingSessionDays,
          dueForReview: longTerm.dueForReview,
        },
        'retention sweep complete',
      );

      return { sessions, events, longTerm };
    } catch (error) {
      logger?.error?.({ err: error }, 'retention sweep failed');
      return { error: true };
    } finally {
      running = false;
    }
  }

  return {
    runOnce,

    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export default createRetentionWorker;
