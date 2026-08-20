import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId, opaqueToken } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { assertCleanFamilyCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { COMMUNICATION_PREFERENCES } from './schemas.js';

export const FAMILY_CONSENT_COPY = Object.freeze({
  version: 'family_consent_v1',
  threshold: 'Become Family.',
  confirmation: 'You are part of the Global Family. Nothing more is asked of you.',
});

for (const [field, text] of Object.entries(FAMILY_CONSENT_COPY)) {
  if (field !== 'version') assertCleanFamilyCopy(text, `FAMILY_CONSENT_COPY.${field}`);
}

const WITHDRAWAL_TOKEN_LENGTH = 32;

function evaluateThreshold(session) {
  if (session?.gates?.allow_become_family === true) {
    return { permitted: true, arrivedFrom: 'convergence_threshold' };
  }
  const arcComplete = session?.progress?.openingArcCompleted === true;
  const onPathways =
    session?.currentState === 'S14' || session?.pathwaySelected === 'become_family';
  if (arcComplete && onPathways) {
    return { permitted: true, arrivedFrom: 'S14_pathway' };
  }
  return { permitted: false, arrivedFrom: null };
}

export function createFamilyService({ db, config, logger = null, mailer = null }) {
  const records = db.collection(COLLECTIONS.FAMILY_MEMBERS);
  const mail = mailer ?? createMailer({ logger });

  function withdrawUrl(token) {
    return `${config.origins.publicOrigin}/family/withdraw?t=${token}`;
  }

  async function sendQuietly(template, to, input) {
    try {
      await mail.sendTemplate(template, to, input);
    } catch (error) {
      logger?.error?.({ err: error, template }, 'family pathway message could not be sent');
    }
  }

  return {
    consentCopy: FAMILY_CONSENT_COPY,

    async becomeFamily(session, input) {
      const { permitted, arrivedFrom } = evaluateThreshold(session);
      if (!permitted) {
        throw new ApiError(403, 'THRESHOLD_NOT_OPEN', 'The threshold is not open from here.');
      }
      if (!COMMUNICATION_PREFERENCES.includes(input.communicationPreference)) {
        throw new ApiError(
          422,
          'PREFERENCE_REQUIRED',
          'Please choose whether you would like to receive occasional updates.',
        );
      }

      const now = new Date();
      const address = input.email.trim().toLowerCase();
      const token = opaqueToken(WITHDRAWAL_TOKEN_LENGTH);

      const document = {
        _id: newId(),
        email: address,
        displayName: typeof input.displayName === 'string' ? input.displayName.trim() : null,
        consent: {
          becameFamilyAt: now,
          copyVersion: FAMILY_CONSENT_COPY.version,
        },
        arrivedFrom,
        sessionId: session._id,
        communicationPreference: input.communicationPreference,
        status: 'active',
        withdrawalToken: token,
        withdrawnAt: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await records.insertOne(document);
      } catch (error) {
        if (error?.code === 11000) {
          return { welcomed: true };
        }
        throw error;
      }

      await sendQuietly('family_welcome', address, {
        displayName: document.displayName,
        communicationPreference: document.communicationPreference,
        withdrawUrl: withdrawUrl(token),
      });

      return { welcomed: true };
    },

    async withdraw(input, options = {}) {
      const now = new Date();

      if (typeof input.token === 'string') {
        const record = await records.findOne(
          { withdrawalToken: input.token },
          { projection: { email: 1 } },
        );
        if (record) {
          await records.deleteOne({ _id: record._id });
          await writeAuditSafe(
            db,
            {
              actorType: 'system',
              action: AUDIT_ACTIONS.FAMILY_WITHDRAWN,
              targetCollection: COLLECTIONS.FAMILY_MEMBERS,
              targetId: record._id,
              after: { removed: true },
              correlationId: options.correlationId ?? null,
            },
            logger,
          );
          await sendQuietly('family_withdrawal', record.email, { completed: true });
        }
        return { received: true };
      }

      if (typeof input.email === 'string') {
        const address = input.email.trim().toLowerCase();
        const token = opaqueToken(WITHDRAWAL_TOKEN_LENGTH);
        const updated = await records.findOneAndUpdate(
          { email: address, status: 'active' },
          { $set: { withdrawalToken: token, ...updateStamps(now) } },
          { returnDocument: 'after', projection: { _id: 1 } },
        );
        if (updated) {
          await sendQuietly('family_withdrawal', address, {
            confirmUrl: withdrawUrl(token),
            completed: false,
          });
        }
        return { received: true };
      }

      return { received: true };
    },
  };
}

export default createFamilyService;
