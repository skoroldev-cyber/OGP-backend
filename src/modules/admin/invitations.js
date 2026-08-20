import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { mintInvitationCode, toInvitationResponse } from './beta.js';
import { buildInvitationUrl, createAdminTemplatesService, escapeHtml } from './templates.js';

export const INVITATION_AUDIT_ACTIONS = Object.freeze({
  INVITATION_SEND_BULK: 'invitation.send_bulk',
  INVITATION_RESEND: 'invitation.resend',
  INVITATION_REVOKE: 'invitation.revoke',
});

const HOLDS_LINK = Object.freeze([
  'invited',
  'welcome_sent',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
]);

const SKIP_REASONS = Object.freeze({
  already_invited: 'already_invited',
  revoked: 'revoked',
  not_selected: 'not_selected',
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CODE_ATTEMPTS = 3;

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

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

  async function deliver(invitation, cohortName, templateKey, note) {
    const message = await copy.render(templateKey, {
      displayName: invitation.displayName,
      invitationUrl: buildInvitationUrl(config, invitation.code),
      cohortName,
      expiresAt: '',
    });

    const text = note ? `${message.text}\n\n${note}` : message.text;
    const html = message.html && note ? `${message.html}\n<p>${escapeHtml(note)}</p>` : message.html;

    try {
      const result = await mail.send({ to: invitation.email, subject: message.subject, text, html });
      if (result?.delivered !== true) {
        return {
          delivered: false,
          reason: result?.transport === 'log' ? 'log_transport' : 'not_delivered',
        };
      }
      return { delivered: true, reason: null };
    } catch (error) {
      logger?.warn?.(
        { invitationId: invitation._id, reason: error.code ?? 'MAIL_FAILED' },
        'an invitation could not be delivered',
      );
      return { delivered: false, reason: shortReason(error) };
    }
  }

  async function requireInvitation(id) {
    const invitation = await invitations.findOne({ _id: id });
    if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'That invitation does not exist.');
    return invitation;
  }

  async function cohortNameFor(cohortId) {
    if (!cohortId) return null;
    const cohort = await cohorts.findOne({ _id: cohortId }, { projection: { name: 1 } });
    if (!cohort) throw new ApiError(404, 'NOT_FOUND', 'That cohort does not exist.');
    return cohort.name ?? null;
  }

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

  async function stampSent(invitation) {
    const now = new Date();
    await invitations.updateOne(
      { _id: invitation._id },
      {
        $set: {
          status: 'invited',
          sentAt: now,
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
    async sendBulk(admin, input, options = {}) {
      const cohortId = input.cohortId ?? null;
      const cohortName = await cohortNameFor(cohortId);
      const templateKey = input.templateKey ?? 'beta_invitation';

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
        after: { ...summary, templateKey, addressed: results.length },
        correlationId: options.correlationId ?? null,
      });

      return { results, ...summary };
    },

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

function shortReason(error) {
  const code = typeof error?.code === 'string' ? error.code : 'MAIL_FAILED';
  return code.slice(0, 64).toLowerCase();
}

export default createAdminInvitationsService;
