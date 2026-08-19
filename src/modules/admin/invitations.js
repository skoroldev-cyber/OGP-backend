/**
 * Founding Reader invitation delivery — bulk send, resend, revoke.
 *
 * A cohort of 15–50 individuals or 5–10 people inside an organisation (§5.7) is invited in
 * one action rather than fifty. That is an operational convenience, not a campaign tool, and
 * three rules keep it on the right side of that line:
 *
 * 1. **One message per address, addressed individually.** Recipients are never placed on a
 *    shared envelope: a Founding Reader must not learn who else is reading, and a cohort
 *    list is exactly the kind of disclosure §9.2.7 keeps closed.
 * 2. **Nobody who already holds a link is messaged again.** A second pass over the same list
 *    is skipped, not resent — a reminder sequence is a drip campaign wearing a study's
 *    clothes (`beta.js`). `POST /admin/invitations/:id/resend` exists for the deliberate,
 *    named, one-at-a-time case, and it is audited on its own.
 * 3. **Partial failure is the normal case and is reported, never thrown.** A relay that
 *    refuses one mailbox has not invalidated the other 499 sends. Every address comes back
 *    with `sent`, `skipped` or `failed` and a short reason.
 *
 * The invitation record is written *before* the send, so a code that reached a mailbox
 * always exists in the database. A failed send leaves the record at its previous status with
 * `lastError` set, which is retryable; a record that claims `invited` always means a message
 * was accepted by the relay.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { mintInvitationCode, toInvitationResponse } from './beta.js';
import { buildInvitationUrl, createAdminTemplatesService, escapeHtml } from './templates.js';

/** Audit actions this module writes that `lib/audit.js` does not already name. */
export const INVITATION_AUDIT_ACTIONS = Object.freeze({
  INVITATION_SEND_BULK: 'invitation.send_bulk',
  INVITATION_RESEND: 'invitation.resend',
  INVITATION_REVOKE: 'invitation.revoke',
});

/**
 * Statuses meaning "this person already has their private reading link". A bulk send passes
 * over them in silence.
 */
const HOLDS_LINK = Object.freeze([
  'invited',
  'welcome_sent',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
]);

/** Reasons a bulk send declines to write to an address. Short, closed, and reportable. */
const SKIP_REASONS = Object.freeze({
  already_invited: 'already_invited',
  revoked: 'revoked',
  not_selected: 'not_selected',
});

/** The address shape the platform accepts. Deliberately permissive; the relay is the judge. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How many times a code collision is retried before the address is reported as failed. */
const CODE_ATTEMPTS = 3;

/**
 * Normalise an address for storage and comparison.
 *
 * @param {unknown} value A candidate address.
 * @returns {string} The lowercased, trimmed address, or an empty string.
 */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * De-duplicate a submitted list, preserving the order the coordinator typed.
 *
 * @param {string[]} emails The submitted addresses.
 * @returns {string[]} Unique normalised addresses.
 */
export function dedupeEmails(emails) {
  const seen = new Set();
  const out = [];
  for (const candidate of emails ?? []) {
    const address = normalizeEmail(candidate);
    const key = address === '' ? `blank:${out.length}` : address;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, mailer?: object,
 *           templates?: object }} deps Dependencies. `mailer` and `templates` are injectable
 *        so a test can drive the whole path without a relay.
 * @returns {object} The admin invitation delivery service.
 */
export function createAdminInvitationsService({
  db,
  config,
  logger = null,
  mailer = null,
  templates = null,
}) {
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const cohorts = db.collection(COLLECTIONS.COHORTS);
  const mail = mailer ?? createMailer({ logger });
  const copy = templates ?? createAdminTemplatesService({ db, config, logger });

  /**
   * Deliver one rendered message. Never throws: the caller records the outcome per address.
   *
   * @param {object} invitation The invitation record.
   * @param {string|null} cohortName The cohort name, or null.
   * @param {string} templateKey The template to render.
   * @param {string|null} note An optional line from the coordinator.
   * @returns {Promise<{ delivered: boolean, reason: string|null }>} The outcome.
   */
  async function deliver(invitation, cohortName, templateKey, note) {
    const message = await copy.render(templateKey, {
      displayName: invitation.displayName,
      invitationUrl: buildInvitationUrl(config, invitation.code),
      cohortName,
      // Phase 1 codes are single-use rather than time-limited (§5.7); nothing claims an
      // expiry the platform does not enforce.
      expiresAt: '',
    });

    const text = note ? `${message.text}\n\n${note}` : message.text;
    const html = message.html && note ? `${message.html}\n<p>${escapeHtml(note)}</p>` : message.html;

    try {
      const result = await mail.send({ to: invitation.email, subject: message.subject, text, html });
      // The log transport writes a record and returns without throwing. Treating that as
      // success is what made the panel say "sent" when nothing left the machine.
      if (result?.delivered !== true) {
        return {
          delivered: false,
          reason: result?.transport === 'log' ? 'log_transport' : 'not_delivered',
        };
      }
      return { delivered: true, reason: null };
    } catch (error) {
      // The address is deliberately absent from this record (§9.10). The correlation is the
      // invitation id, which is not a person.
      logger?.warn?.(
        { invitationId: invitation._id, reason: error.code ?? 'MAIL_FAILED' },
        'an invitation could not be delivered',
      );
      return { delivered: false, reason: shortReason(error) };
    }
  }

  /**
   * @param {string} id An invitation `_id`.
   * @returns {Promise<object>} The invitation.
   * @throws {ApiError} 404 when it does not exist.
   */
  async function requireInvitation(id) {
    const invitation = await invitations.findOne({ _id: id });
    if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'That invitation does not exist.');
    return invitation;
  }

  /**
   * @param {string|null} cohortId A cohort identifier.
   * @returns {Promise<string|null>} The cohort name.
   * @throws {ApiError} 404 when a named cohort does not exist.
   */
  async function cohortNameFor(cohortId) {
    if (!cohortId) return null;
    const cohort = await cohorts.findOne({ _id: cohortId }, { projection: { name: 1 } });
    if (!cohort) throw new ApiError(404, 'NOT_FOUND', 'That cohort does not exist.');
    return cohort.name ?? null;
  }

  /**
   * Create an invitation for an address the platform has not seen, retrying on a code
   * collision rather than handing the coordinator a duplicate-key error.
   *
   * @param {string} address The normalised address.
   * @param {string|null} cohortId The cohort.
   * @returns {Promise<object>} The stored invitation.
   */
  async function createFor(address, cohortId) {
    let lastError = null;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const document = {
        _id: newId(),
        cohortId: cohortId ?? null,
        code: mintInvitationCode(),
        email: address,
        displayName: null,
        country: null,
        preferredLanguage: null,
        occupationBackground: null,
        source: null,
        status: 'new_interest',
        redeemedBySessionId: null,
        redeemedAt: null,
        welcomeEmailSentAt: null,
        readingLinkSentAt: null,
        sentAt: null,
        sendCount: 0,
        lastError: null,
        firstOpenedAt: null,
        revokedAt: null,
        notes: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };
      try {
        await invitations.insertOne(document);
        return document;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Record a successful send.
   *
   * @param {object} invitation The invitation.
   * @returns {Promise<void>} Resolves when stamped.
   */
  async function stampSent(invitation) {
    const now = new Date();
    await invitations.updateOne(
      { _id: invitation._id },
      {
        $set: {
          status: 'invited',
          sentAt: now,
          // Both Airtable funnel columns advance together, because the one message the
          // platform sends *is* the welcome and *is* the reading link (§10.7.2).
          welcomeEmailSentAt: invitation.welcomeEmailSentAt ?? now,
          readingLinkSentAt: now,
          lastError: null,
          ...updateStamps(now),
        },
        $inc: { sendCount: 1 },
      },
    );
  }

  return {
    /**
     * `POST /admin/invitations/send` — one to five hundred addresses, one message each.
     *
     * @param {object} admin The acting administrator.
     * @param {{ emails: string[], cohortId?: string, templateKey?: string,
     *           message?: string }} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ results: Array<{ email: string, status: string,
     *                     reason: string|null }>, sent: number, skipped: number,
     *                     failed: number }>} The per-address outcome.
     */
    async sendBulk(admin, input, options = {}) {
      const cohortId = input.cohortId ?? null;
      const cohortName = await cohortNameFor(cohortId);
      const templateKey = input.templateKey ?? 'beta_invitation';

      // A coordinator's added line is reader-facing copy and is held to the same rules as
      // the template it rides on. Rejecting the whole request is right: the line is one
      // decision, and half a batch carrying it would be worse than none.
      const note = typeof input.message === 'string' && input.message.trim() !== ''
        ? assertCleanCopy(input.message.trim(), 'message')
        : null;

      const results = [];
      for (const address of dedupeEmails(input.emails)) {
        if (address === '' || !EMAIL_PATTERN.test(address)) {
          results.push({ email: address, status: 'failed', reason: 'invalid_address' });
          continue;
        }

        let invitation;
        try {
          invitation = await invitations.findOne({ email: address });
          if (invitation) {
            if (invitation.status === 'revoked') {
              results.push({ email: address, status: 'skipped', reason: SKIP_REASONS.revoked });
              continue;
            }
            if (invitation.status === 'not_selected') {
              results.push({ email: address, status: 'skipped', reason: SKIP_REASONS.not_selected });
              continue;
            }
            if (HOLDS_LINK.includes(invitation.status)) {
              results.push({
                email: address,
                status: 'skipped',
                reason: SKIP_REASONS.already_invited,
              });
              continue;
            }
            // The existing record is reused, code and all: a participant has one code for
            // the life of the study, and re-issuing would strand the link they already hold.
            if (cohortId && invitation.cohortId !== cohortId) {
              await invitations.updateOne(
                { _id: invitation._id },
                { $set: { cohortId, ...updateStamps(new Date()) } },
              );
              invitation = { ...invitation, cohortId };
            }
          } else {
            invitation = await createFor(address, cohortId);
          }
        } catch (error) {
          logger?.error?.({ err: error }, 'an invitation record could not be prepared');
          results.push({ email: address, status: 'failed', reason: 'record_failed' });
          continue;
        }

        const outcome = await deliver(invitation, cohortName, templateKey, note);
        if (outcome.delivered) {
          await stampSent(invitation);
          results.push({ email: address, status: 'sent', reason: null });
        } else {
          await invitations.updateOne(
            { _id: invitation._id },
            { $set: { lastError: outcome.reason, ...updateStamps(new Date()) } },
          );
          results.push({ email: address, status: 'failed', reason: outcome.reason });
        }
      }

      const summary = {
        sent: results.filter((entry) => entry.status === 'sent').length,
        skipped: results.filter((entry) => entry.status === 'skipped').length,
        failed: results.filter((entry) => entry.status === 'failed').length,
      };

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: INVITATION_AUDIT_ACTIONS.INVITATION_SEND_BULK,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: cohortId,
        // Counts, not the list. Copying five hundred addresses into an append-only
        // collection would put PII somewhere it can never be corrected or erased (§9.5).
        after: { ...summary, templateKey, addressed: results.length },
        correlationId: options.correlationId ?? null,
      });

      return { results, ...summary };
    },

    /**
     * `POST /admin/invitations/:id/resend` — the deliberate, single, audited repeat.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The invitation identifier.
     * @param {{ templateKey?: string }} [input] The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ invitation: object, delivered: boolean }>} The result.
     */
    async resend(admin, id, input = {}, options = {}) {
      const invitation = await requireInvitation(id);
      if (typeof invitation.email !== 'string' || invitation.email === '') {
        throw new ApiError(422, 'NO_ADDRESS', 'That invitation has no address to write to.');
      }
      if (invitation.status === 'revoked') {
        throw new ApiError(
          409,
          'INVITATION_REVOKED',
          'That reading link has been withdrawn. Issue a new invitation instead.',
        );
      }

      const cohortName = await cohortNameFor(invitation.cohortId ?? null);
      const outcome = await deliver(
        invitation,
        cohortName,
        input.templateKey ?? 'beta_invitation',
        null,
      );

      if (!outcome.delivered) {
        await invitations.updateOne(
          { _id: id },
          { $set: { lastError: outcome.reason, ...updateStamps(new Date()) } },
        );
        throw new ApiError(
          503,
          'MAIL_UNAVAILABLE',
          'The message could not be sent. Nothing was changed.',
        );
      }

      await stampSent(invitation);

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: INVITATION_AUDIT_ACTIONS.INVITATION_RESEND,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: id,
        before: { status: invitation.status, sendCount: invitation.sendCount ?? 0 },
        after: { status: 'invited' },
        correlationId: options.correlationId ?? null,
      });

      return { invitation: toInvitationResponse(await requireInvitation(id)), delivered: true };
    },

    /**
     * `POST /admin/invitations/:id/revoke` — withdraw a private reading link.
     *
     * §10.7.2 requires a leaked link to be individually revocable. Revocation is recorded
     * rather than deleted: the participant's place in the funnel is study data, and erasing
     * it would falsify the record of who was approached.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The invitation identifier.
     * @param {{ reason?: string }} [input] The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ invitation: object }>} The revoked invitation.
     */
    async revoke(admin, id, input = {}, options = {}) {
      const invitation = await requireInvitation(id);
      if (invitation.status === 'revoked') {
        return { invitation: toInvitationResponse(invitation) };
      }

      const now = new Date();
      const updated = await invitations.findOneAndUpdate(
        { _id: id },
        { $set: { status: 'revoked', revokedAt: now, ...updateStamps(now) } },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: INVITATION_AUDIT_ACTIONS.INVITATION_REVOKE,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: id,
        before: { status: invitation.status },
        after: { status: 'revoked', reason: input.reason ?? null },
        correlationId: options.correlationId ?? null,
      });

      return { invitation: toInvitationResponse(updated) };
    },
  };
}

/**
 * A short, storable reason for a failed send.
 *
 * Never the relay's full reply: an SMTP diagnostic can quote the address it refused, and
 * `lastError` is read by a dashboard and written to a database (§9.10).
 *
 * @param {Error & { code?: string }} error The failure.
 * @returns {string} The reason.
 */
function shortReason(error) {
  const code = typeof error?.code === 'string' ? error.code : 'MAIL_FAILED';
  return code.slice(0, 64).toLowerCase();
}

export default createAdminInvitationsService;
