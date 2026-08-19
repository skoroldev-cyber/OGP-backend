/**
 * The "Become Family." threshold.
 *
 * The locked phrase, with its trailing period, is the only rendering this pathway ever
 * uses. "Become a Global Family Member" is an internal pathway identifier and appears
 * nowhere a reader can see it; no string this module produces contains the words this
 * pathway forbids, and `assertCleanFamilyCopy` proves it at import time rather than
 * trusting anyone to remember.
 *
 * ## The rarity guard
 *
 * The threshold appears at exactly two surfaces, both rare (§5.5): the validated
 * convergence threshold inside the reading room, and S14 pathway 4. The server enforces the
 * same rarity the frontend does, so a client that renders it anywhere else still cannot
 * create a record:
 *
 *   `gates.allow_become_family === true` — the convergence-threshold route, which requires
 *   a **validated** `convergence_threshold` resonance node on the current unit and a
 *   terminal immersion state
 *   **or**
 *   the Opening Arc is complete **and** the reader is on Choose Your Path — the S14 route.
 *
 * ## Consent
 *
 * `consent.copyVersion` records exactly which approved copy was shown. It is a version
 * label rather than a free-text snapshot, and it is minted here rather than accepted from
 * the client: a consent record that trusted the client to describe what it displayed would
 * record nothing worth having. Changing the copy means minting a new version below.
 *
 * ## Withdrawal
 *
 * Withdrawal deletes the record. The approved message says "Your record has been removed",
 * and that has to be literally true — a suppression row carrying the same address would
 * make it a euphemism. Nothing else is affected: reading and any transcript access a person
 * holds are independent of this record and survive it.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId, opaqueToken } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { assertCleanFamilyCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { COMMUNICATION_PREFERENCES } from './schemas.js';

/**
 * The approved copy shown at the threshold, and the version stamped on every consent
 * record. Bump the version whenever the text changes; the two must move together, which is
 * why they live in one object.
 */
export const FAMILY_CONSENT_COPY = Object.freeze({
  version: 'family_consent_v1',
  threshold: 'Become Family.',
  confirmation: 'You are part of the Global Family. Nothing more is asked of you.',
});

// Proved at import. If the copy ever drifts into prohibited vocabulary the service refuses
// to load, rather than quietly recording consent against a string that should not exist.
for (const [field, text] of Object.entries(FAMILY_CONSENT_COPY)) {
  if (field !== 'version') assertCleanFamilyCopy(text, `FAMILY_CONSENT_COPY.${field}`);
}

/** Withdrawal links are opaque and long; they are the only credential this pathway has. */
const WITHDRAWAL_TOKEN_LENGTH = 32;

/**
 * @param {object} session A `reading_sessions` document.
 * @returns {{ permitted: boolean, arrivedFrom: string|null }} The guard decision.
 */
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

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, mailer?: object }} deps
 *        Dependencies.
 * @returns {object} The family service.
 */
export function createFamilyService({ db, config, logger = null, mailer = null }) {
  const records = db.collection(COLLECTIONS.FAMILY_MEMBERS);
  const mail = mailer ?? createMailer({ logger });

  function withdrawUrl(token) {
    return `${config.origins.publicOrigin}/family/withdraw?t=${token}`;
  }

  /**
   * Send one message without ever letting a mail failure undo a reader's action.
   *
   * @param {string} template Template name.
   * @param {string} to Recipient.
   * @param {object} input Template input.
   * @returns {Promise<void>} Always resolves.
   */
  async function sendQuietly(template, to, input) {
    try {
      await mail.sendTemplate(template, to, input);
    } catch (error) {
      logger?.error?.({ err: error, template }, 'family pathway message could not be sent');
    }
  }

  return {
    /** The copy this service records consent against. */
    consentCopy: FAMILY_CONSENT_COPY,

    /**
     * `POST /family`.
     *
     * @param {object} session The authenticated session document.
     * @param {object} input The validated request body.
     * @returns {Promise<{ welcomed: true }>} Confirmation.
     */
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
        // Severable: `DELETE /sessions/current` nulls it.
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
          // A record already exists for this address. Answer identically rather than
          // reporting it: the response must not become a way to test whether an address is
          // already recorded, and an existing record is never modified by a request that
          // did not prove control of the address.
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

    /**
     * `POST /family/withdraw`. Always answers `202 { received: true }`, whether or not a
     * record exists, so the endpoint cannot be used to test addresses.
     *
     * @param {{ email?: string, token?: string }} input The validated request body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ received: true }>} Confirmation.
     */
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
              // No before-image and no address: an audit trail that preserved what was
              // withdrawn would defeat the withdrawal.
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
