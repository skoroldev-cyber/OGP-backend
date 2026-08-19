/**
 * Founding Reader invitation redemption.
 *
 * An invitation code is opaque and single-use. Redemption is one conditional
 * `findOneAndUpdate`: the filter requires an unclaimed record, so two clients racing the
 * same code produce exactly one winner and the loser is told the code is unavailable.
 *
 * **The privacy wall is structural, not procedural.** `invitations` holds the invitee's
 * PII. `reading_sessions` holds none of it and never will — this module copies the cohort
 * identifier, the invitation identifier and the Founding Reader flag onto the session, and
 * nothing else. The email address, the display name, the country, the language and the
 * occupation stay in the invitation record. The two collections join only through
 * `redeemedBySessionId`, which is exposed solely to admin completion tracking; the
 * dashboard reports cohort-level aggregates and never a per-invitee reading trail.
 *
 * An unknown code and an already-claimed code produce the same calm `404`. Distinguishing
 * them would turn the endpoint into an oracle for which codes exist.
 */

import { COLLECTIONS, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { ApiError } from '../../plugins/errors.js';

/** The edition a Founding Reader receives when a cohort names none (§5.6). */
const DEFAULT_BETA_EDITION = 'beta_reader_v2_0';

/** Statuses from which a code may no longer be claimed. */
const CLOSED_STATUSES = Object.freeze(['redeemed', 'questionnaire_completed', 'not_selected']);

function unavailable() {
  // Calm, non-specific, and identical for "no such code" and "already used".
  return new ApiError(404, 'CODE_NOT_AVAILABLE', 'That reading code is not available.');
}

/**
 * @param {{ db: import('mongodb').Db, logger?: object }} deps Dependencies.
 * @returns {object} The invitations service.
 */
export function createInvitationsService({ db, logger = null }) {
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const cohorts = db.collection(COLLECTIONS.COHORTS);
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);

  /**
   * Resolve the cohort facing a reader. Only the name and the edition cross this boundary.
   *
   * @param {string|null} cohortId The cohort identifier.
   * @returns {Promise<{ name: string|null, edition: string }>} The reader-facing cohort.
   */
  async function describeCohort(cohortId) {
    if (typeof cohortId !== 'string' || cohortId === '') {
      return { name: null, edition: DEFAULT_BETA_EDITION };
    }
    const cohort = await cohorts.findOne(
      { _id: cohortId },
      { projection: { name: 1, manuscriptEdition: 1 } },
    );
    return {
      name: cohort?.name ?? null,
      edition: cohort?.manuscriptEdition ?? DEFAULT_BETA_EDITION,
    };
  }

  return {
    /**
     * Redeem a code against the calling session.
     *
     * @param {object} session The authenticated session document.
     * @param {{ code: string }} input The validated request body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ cohort: { name: string|null }, edition: string }>} The cohort.
     */
    async redeem(session, input, options = {}) {
      const code = input.code;
      const now = new Date();

      // Re-submitting the code this session already redeemed is not a failure. The reader
      // refreshed a page; give them the same answer.
      if (typeof session.invitationId === 'string') {
        const existing = await invitations.findOne(
          { _id: session.invitationId, code },
          { projection: { cohortId: 1 } },
        );
        if (existing) {
          const cohort = await describeCohort(existing.cohortId ?? null);
          return { cohort: { name: cohort.name }, edition: cohort.edition };
        }
      }

      const claimed = await invitations.findOneAndUpdate(
        {
          code,
          redeemedBySessionId: null,
          status: { $nin: CLOSED_STATUSES },
        },
        {
          $set: {
            status: 'redeemed',
            redeemedBySessionId: session._id,
            redeemedAt: now,
            ...updateStamps(now),
          },
        },
        // Only what the session is allowed to learn. The invitee's PII is not projected,
        // so it cannot be logged, cached or serialised by accident further down.
        { returnDocument: 'after', projection: { cohortId: 1 } },
      );
      if (!claimed) throw unavailable();

      const cohort = await describeCohort(claimed.cohortId ?? null);

      await sessions.updateOne(
        { _id: session._id },
        {
          $set: {
            isFoundingReader: true,
            cohortId: claimed.cohortId ?? null,
            invitationId: claimed._id,
            // Provenance is only claimed when none was recorded at session creation;
            // rewriting it afterwards would falsify how the reader actually arrived.
            ...(session.entryVia ? {} : { entryVia: 'invitation' }),
            ...updateStamps(now),
          },
        },
      );

      await writeAuditSafe(
        db,
        {
          actorType: 'system',
          action: AUDIT_ACTIONS.INVITATION_REDEEM,
          targetCollection: COLLECTIONS.INVITATIONS,
          targetId: claimed._id,
          after: { status: 'redeemed', cohortId: claimed.cohortId ?? null },
          correlationId: options.correlationId ?? null,
        },
        logger,
      );

      return { cohort: { name: cohort.name }, edition: cohort.edition };
    },
  };
}

export default createInvitationsService;
