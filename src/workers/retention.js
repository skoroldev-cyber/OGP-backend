/**
 * Retention sweeps (§9.5.4).
 *
 * Data minimisation is a product feature, which means deletion has to be a scheduled
 * mechanism rather than an intention. The periods below are the master document's, carried
 * here as configuration so a founder review changes one object rather than a dozen call
 * sites:
 *
 *   `reading_sessions`   400 days after `lastReadAt`  — TTL index, swept here as a backstop
 *   `events` (raw)       24 months, then aggregate-and-delete
 *   `share_tokens`       durable unless revoked        — never swept
 *   commerce + audit     7 years                       — reported, never auto-deleted
 *
 * Two deliberate refusals:
 *
 * - **Financial and audit records are never deleted by a background job.** The pass reports
 *   how many rows have passed their seven-year mark and stops there. Destroying accounting
 *   or audit history on a timer is a decision for a person with the legal context, not for
 *   a `setInterval`.
 * - **The aggregate is written before the raw rows are deleted, or the deletion does not
 *   happen.** `runEventRetention` hands its rollup to a sink and only deletes when the sink
 *   resolves. The default sink logs the rollup; when the admin dashboard's daily-rollup
 *   collection exists (§10, `metrics_daily` — not yet registered in `db/collections.js`,
 *   and nothing outside that file may name a collection), the sink writes there instead and
 *   nothing else in this file changes.
 *
 * TTL expiry of a session removes the document with the age band in it. The severable
 * `sessionId` left on a donation or a questionnaire response then points at nothing: it
 * holds no PII, resolves to no document, and cannot be joined back to reading behaviour.
 * `DELETE /sessions/current` is the path that severs those references explicitly.
 */

import { COLLECTIONS } from '../db/collections.js';

/** §9.5.4, founder review pending. Override per call site rather than editing here. */
export const RETENTION_PERIODS = Object.freeze({
  /** `reading_sessions.expiresAt` is set to `lastReadAt + this`. */
  readingSessionDays: 400,
  /** Raw `events` rows older than this are aggregated, then deleted. */
  rawEventMonths: 24,
  /** Commerce records — reported only. */
  commerceYears: 7,
  /** Audit trail — reported only. */
  auditYears: 7,
});

/** Default cadence for `start()`. Retention is a daily concern, not a per-request one. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Documents deleted per `deleteMany` pass, so a large sweep never holds a long lock. */
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

/**
 * The default rollup sink: a structured log line per bucket.
 *
 * The rollup contains no session identifier, no payload and no reader-supplied value —
 * only a day, an event name, a content layer and a count. That is the maximum an aggregate
 * may carry and still honour the anti-profiling rules.
 *
 * @param {object[]} rollups Daily buckets.
 * @param {{ logger?: object }} context Sink context.
 * @returns {Promise<void>} Resolves when the rollup has been recorded.
 */
async function defaultSink(rollups, { logger }) {
  for (const rollup of rollups) {
    logger?.info?.({ rollup }, 'event rollup before deletion');
  }
}

/**
 * Delete in bounded chunks.
 *
 * @param {import('mongodb').Collection} collection The collection.
 * @param {object} filter The delete filter.
 * @returns {Promise<number>} How many documents were deleted.
 */
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

/**
 * Sweep expired reading sessions.
 *
 * The TTL index on `expiresAt` is the primary mechanism; MongoDB's TTL monitor runs about
 * once a minute and can lag under load, and a TTL index is not applied at all until
 * `npm run db:indexes` has run against the environment. This pass is the backstop that
 * makes the retention promise true regardless.
 *
 * A document written before the TTL field existed, or one whose `expiresAt` was somehow
 * cleared, is caught by the idle branch: 400 days without a read is the retention horizon
 * whether or not a TTL value was ever stored.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ now?: Date, days?: number }} [options] Clock and horizon overrides.
 * @returns {Promise<{ deleted: number }>} Summary.
 */
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

/**
 * Aggregate raw events past their retention horizon into daily buckets.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ before: Date }} options The retention cutoff.
 * @returns {Promise<object[]>} Daily buckets `{ day, name, contentLayer, count }`.
 */
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

/**
 * The aggregate-then-delete pass for raw events.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ now?: Date, months?: number, sink?: Function, logger?: object }} [options] Options.
 * @returns {Promise<{ cutoff: string, buckets: number, deleted: number }>} Summary.
 */
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

  // Deletion is conditional on the aggregate surviving. If the sink throws, the raw rows
  // stay and the next pass tries again — losing the aggregate is worse than keeping the
  // rows one more day.
  await sink(rollups, { logger, cutoff });

  const deleted = await deleteInChunks(db.collection(COLLECTIONS.EVENTS), {
    receivedAt: { $lt: cutoff },
  });
  return { cutoff: cutoff.toISOString(), buckets: rollups.length, deleted };
}

/**
 * Count records past the seven-year horizon. Reported, never deleted.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ now?: Date, periods?: object }} [options] Options.
 * @returns {Promise<object>} Counts per collection.
 */
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

/**
 * Build the retention worker.
 *
 * No scheduler is wired into the API process: a sweep belongs to a cron entry or a platform
 * job so two API nodes do not run it simultaneously. `start()` exists for a single-node
 * deployment that has no scheduler of its own.
 *
 * @param {{ db: import('mongodb').Db, config?: object, logger?: object, periods?: object,
 *           sink?: Function, intervalMs?: number }} deps Dependencies.
 * @returns {{ runOnce: Function, start: Function, stop: Function }} The worker.
 */
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

  /**
   * Run every pass once.
   *
   * @param {{ now?: Date }} [options] Clock override for tests.
   * @returns {Promise<object>} Summary of every pass.
   */
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

    /** Start the periodic sweep. Idempotent. */
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref?.();
    },

    /** Stop the periodic sweep. */
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export default createRetentionWorker;
