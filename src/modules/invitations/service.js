import { COLLECTIONS, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { ApiError } from '../../plugins/errors.js';

const DEFAULT_BETA_EDITION = 'beta_reader_v2_0';

const CLOSED_STATUSES = Object.freeze(['redeemed', 'questionnaire_completed', 'not_selected']);

function unavailable() {
  return new ApiError(404, 'CODE_NOT_AVAILABLE', 'That reading code is not available.');
}

export function createInvitationsService({ db, logger = null }) {
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const cohorts = db.collection(COLLECTIONS.COHORTS);
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);

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
    async redeem(session, input, options = {}) {
      const code = input.code;
      const now = new Date();

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
