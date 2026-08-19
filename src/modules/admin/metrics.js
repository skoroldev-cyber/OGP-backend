/**
 * Analytics.
 *
 * Everything here is computed from the server-side event store. There is no third-party
 * analytics SDK anywhere in the platform, no session replay, and no client-side beacon —
 * the tools that would make these numbers easy are the same tools that optimise for the
 * mechanics §14.4 prohibits.
 *
 * Four constraints shape every function below:
 *
 * 1. **Aggregate over individual.** The funnel counts distinct sessions per rung and
 *    returns counts. There is no per-session drill-down, no timeline lookup and no export
 *    of individual rows for anonymous readers (§10.2.1).
 * 2. **No age dimension exists.** Not as a filter, not as a group key, not as a returned
 *    field. Age band is session state used to choose a rendering; the privacy statement
 *    says it is not used to profile, and the way to keep that true is to make the slice
 *    unbuildable rather than merely unbuilt (§10.4.6).
 * 3. **Nothing here reaches a reader.** Every route is admin-authenticated and CORS-locked.
 *    A completion count rendered in reader-facing UI would be a social-proof indicator, so
 *    no public endpoint exposes any of these numbers (§10.2.3).
 * 4. **Progression, not vanity.** The ladder measures whether people arrive somewhere
 *    meaningful — threshold, reading, completion, a chosen pathway. Skip is a legitimate
 *    path and a rung it bypasses is not a failure; the dashboard must not optimise toward
 *    conversion, and this module gives it nothing to optimise with.
 */

import { STATE_CODES } from '../../config/constants.js';
import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

/**
 * The S0–S14 ladder, expressed in canonical events. Only the eleven canonical events exist
 * in the store, so states they do not cover (S0, S2, S4, S6, S8, S12) have no rung: an
 * invented rung would be a number nobody could act on.
 */
export const FUNNEL_LADDER = Object.freeze([
  { state: 'S1', event: 'LandingStarted' },
  { state: 'S3', event: 'LogoManifestationStarted' },
  { state: 'S5', event: 'PortalEntryStarted' },
  { state: 'S7', event: 'EarthRevealCompleted' },
  { state: 'S9', event: 'ReadingRoomEntered' },
  { state: 'S10', event: 'ReadingSessionStarted' },
  { state: 'S11', event: 'SharePromptDisplayed' },
  { state: 'S13', event: 'OpeningArcCompleted' },
  { state: 'S14', event: 'PathwaySelected' },
]);

/** Default window when the caller names none. */
const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * @param {object} query A query string carrying optional `from` and `to`.
 * @returns {{ from: Date, to: Date }} The resolved window.
 */
export function resolveWindow(query = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ApiError(422, 'BAD_RANGE', 'That date range could not be read.');
  }
  if (from.getTime() > to.getTime()) {
    throw new ApiError(422, 'BAD_RANGE', 'The start of that range falls after its end.');
  }
  return { from, to };
}

/**
 * @param {number} numerator The rung count.
 * @param {number} denominator The reference count.
 * @returns {number|null} A ratio rounded to four places, or null when undefined.
 */
function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * @param {{ db: import('mongodb').Db, beta?: object }} deps Dependencies. `beta` supplies
 *        the cohort funnel so the two views can never disagree about how it is counted.
 * @returns {object} The admin metrics service.
 */
export function createAdminMetricsService({ db, beta = null }) {
  const events = db.collection(COLLECTIONS.EVENTS);
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);
  const cohorts = db.collection(COLLECTIONS.COHORTS);

  /**
   * Distinct sessions per event name in a window.
   *
   * Two `$group` stages rather than `$addToSet`: deduplicating in a grouping key keeps the
   * working set bounded regardless of how many sessions the window contains.
   *
   * @param {string[]} names Event names.
   * @param {{ from: Date, to: Date }} window The window.
   * @returns {Promise<Map<string, number>>} Name → distinct session count.
   */
  async function distinctSessionsByEvent(names, window) {
    const rows = await events
      .aggregate(
        [
          {
            $match: {
              name: { $in: names },
              receivedAt: { $gte: window.from, $lte: window.to },
              sessionId: { $ne: null },
            },
          },
          { $group: { _id: { name: '$name', sessionId: '$sessionId' } } },
          { $group: { _id: '$_id.name', sessions: { $sum: 1 } } },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    return new Map(rows.map((row) => [row._id, row.sessions]));
  }

  return {
    /**
     * `GET /admin/metrics/funnel?from&to`.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<object>} The ladder.
     */
    async funnel(query = {}) {
      const window = resolveWindow(query);
      const counts = await distinctSessionsByEvent(
        FUNNEL_LADDER.map((rung) => rung.event),
        window,
      );

      const arrivals = counts.get('LandingStarted') ?? 0;
      let previous = null;
      const steps = FUNNEL_LADDER
        // Keep the ladder in canonical state order, whatever order the constant is edited in.
        .slice()
        .sort((a, b) => STATE_CODES.indexOf(a.state) - STATE_CODES.indexOf(b.state))
        .map((rung) => {
          const sessions = counts.get(rung.event) ?? 0;
          const step = {
            state: rung.state,
            event: rung.event,
            sessions,
            stepConversion: previous === null ? null : ratio(sessions, previous),
            cumulativeConversion: ratio(sessions, arrivals),
          };
          previous = sessions;
          return step;
        });

      return {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        steps,
      };
    },

    /**
     * `GET /admin/metrics/events?name&bucket=day`.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<object>} A daily series.
     */
    async eventSeries(query = {}) {
      const window = resolveWindow(query);
      const match = {
        receivedAt: { $gte: window.from, $lte: window.to },
      };
      if (query.name) match.name = query.name;

      const rows = await events
        .aggregate(
          [
            { $match: match },
            {
              $group: {
                _id: {
                  bucket: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
                  name: '$name',
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { '_id.bucket': 1, '_id.name': 1 } },
            { $limit: 1000 },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return {
        bucket: 'day',
        series: rows.map((row) => ({
          bucket: row._id.bucket,
          name: row._id.name,
          count: row.count,
        })),
      };
    },

    /**
     * `GET /admin/metrics/cohorts/:id`.
     *
     * Beta participants are the one consented population, so a cohort view is permitted —
     * still as counts. `reading` reports how many sessions in the cohort started and how
     * many finished the arc; it names nobody and cannot be expanded into a list.
     *
     * @param {string} cohortId The cohort identifier.
     * @returns {Promise<object>} The cohort metrics.
     */
    async cohortMetrics(cohortId) {
      const cohort = await cohorts.findOne({ _id: cohortId }, { projection: { _id: 1 } });
      if (!cohort) throw new ApiError(404, 'NOT_FOUND', 'That cohort does not exist.');

      const [funnel, sessionsStarted, openingArcCompleted] = await Promise.all([
        beta
          ? beta.funnelFor(cohortId)
          : Promise.resolve({
              interested: 0,
              approved: 0,
              linkSent: 0,
              redeemed: 0,
              questionnaireCompleted: 0,
              followUpNeeded: 0,
              notSelected: 0,
            }),
        sessions.countDocuments({ cohortId }),
        sessions.countDocuments({ cohortId, 'progress.openingArcCompleted': true }),
      ]);

      return {
        cohortId,
        funnel,
        reading: { sessionsStarted, openingArcCompleted },
      };
    },
  };
}

export default createAdminMetricsService;
