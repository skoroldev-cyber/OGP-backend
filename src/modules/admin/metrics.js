import { STATE_CODES } from '../../config/constants.js';
import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

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

const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

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

function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function createAdminMetricsService({ db, beta = null }) {
  const events = db.collection(COLLECTIONS.EVENTS);
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);
  const cohorts = db.collection(COLLECTIONS.COHORTS);

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
    async funnel(query = {}) {
      const window = resolveWindow(query);
      const counts = await distinctSessionsByEvent(
        FUNNEL_LADDER.map((rung) => rung.event),
        window,
      );

      const arrivals = counts.get('LandingStarted') ?? 0;
      let previous = null;
      const steps = FUNNEL_LADDER
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
