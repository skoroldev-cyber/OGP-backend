/**
 * Founding Reader programme administration — cohorts, invitations and the Airtable bridge.
 *
 * Beta participants are the one class of named humans in the platform. Their records exist
 * under explicit study consent, and this module is the only place that reads them in bulk.
 * Two boundaries hold throughout:
 *
 * 1. **A participant is never a reading trail.** `redeemedBySessionId` exists so a cohort
 *    funnel can be counted; it is not projected by any response in this module, so no
 *    dashboard view can pivot from a named person to what they read (§10.2).
 * 2. **One welcome, one link, one message.** `send-welcome` carries the private reading
 *    link, stamps both funnel columns, and is idempotent by status: a second call to a
 *    participant who already has their link sends nothing. There is no reminder sequence,
 *    because a reminder sequence is a drip campaign wearing a study's clothes.
 *
 * The interim operating mode is canon: LinkedIn post → email → Airtable → welcome →
 * private reading link → questionnaire (§10.7.1). Until cutover this module accepts a
 * one-way CSV import from that table, deduplicated by email address. Import never deletes,
 * never overwrites a later funnel state with an earlier one, and never invents consent.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit } from '../../lib/audit.js';
import { newId, opaqueToken } from '../../lib/ids.js';
import { createMailer } from '../../lib/mailer.js';
import { ApiError } from '../../plugins/errors.js';
import { toInteger, toIso } from './schemas.js';
import { buildInvitationUrl } from './templates.js';

/** Audit actions this module writes that `lib/audit.js` does not already name. */
export const BETA_AUDIT_ACTIONS = Object.freeze({
  COHORT_CREATE: 'cohort.create',
  INVITATION_UPDATE: 'invitation.update',
  INVITATION_IMPORT: 'invitation.import',
});

/**
 * Statuses at or beyond "approved", in funnel order.
 *
 * The platform's own delivery states are ranked alongside the Airtable ones (see
 * `INVITATION_STATUSES`): `invited` is what the dashboard writes when it sends a private
 * reading link, and `reading_link_sent` is what an Airtable import writes for the same
 * event. They must count as the same rung, or a cohort's funnel would read differently
 * depending on which system recorded the send.
 */
const APPROVED_OR_LATER = Object.freeze([
  'approved',
  'invited',
  'welcome_sent',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
]);

const LINK_SENT_OR_LATER = Object.freeze([
  'invited',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
]);

const REDEEMED_OR_LATER = Object.freeze(['redeemed', 'questionnaire_completed']);

/** Statuses from which the welcome has already gone out. */
const WELCOMED_STATUSES = Object.freeze([
  'invited',
  'welcome_sent',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
]);

/** Airtable's exact status strings (§10.7.2) mapped onto the stored vocabulary. */
export const AIRTABLE_STATUS_MAP = Object.freeze({
  'new interest': 'new_interest',
  approved: 'approved',
  'welcome sent': 'welcome_sent',
  'reading link sent': 'reading_link_sent',
  'opening arc link sent': 'reading_link_sent',
  'questionnaire completed': 'questionnaire_completed',
  'follow-up needed': 'follow_up_needed',
  'follow up needed': 'follow_up_needed',
  'not selected': 'not_selected',
});

/** Airtable column headings mapped onto stored fields. Case- and spacing-insensitive. */
const CSV_COLUMN_MAP = Object.freeze({
  firstname: 'firstName',
  lastname: 'lastName',
  name: 'displayName',
  email: 'email',
  country: 'country',
  preferredlanguage: 'preferredLanguage',
  occupationbackground: 'occupationBackground',
  occupation: 'occupationBackground',
  source: 'source',
  status: 'status',
  dateofinterest: 'dateOfInterest',
  welcomeemailsent: 'welcomeEmailSent',
  openingarclinksent: 'readingLinkSent',
  questionnairecompleted: 'questionnaireCompleted',
  notes: 'notes',
});

const SOURCE_VALUES = Object.freeze(['linkedin', 'email', 'org', 'direct']);

/** Invitation code length. Opaque, single-use, and typable for organisation cohorts. */
const INVITATION_CODE_LENGTH = 21;

/**
 * Escape a coordinator's search text so a stray `(` or `*` is a character to find rather
 * than a pattern to run.
 *
 * @param {string} value The raw search text.
 * @returns {string} A literal-matching pattern.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mint an invitation code that satisfies the reader-facing code pattern (which requires an
 * alphanumeric first character).
 *
 * @returns {string} The code.
 */
export function mintInvitationCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = opaqueToken(INVITATION_CODE_LENGTH);
    if (/^[A-Za-z0-9]/.test(candidate)) return candidate;
  }
  return `R${opaqueToken(INVITATION_CODE_LENGTH - 1)}`;
}

/**
 * Parse RFC 4180-ish CSV text. Quoted fields, doubled quotes, CRLF or LF line endings.
 * Deliberately small: the alternative is a dependency, and the locked dependency set has
 * no room for one.
 *
 * @param {string} text The CSV document.
 * @returns {string[][]} Rows of fields.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

/**
 * Interpret an Airtable cell that may hold a date, a checkbox, or nothing.
 *
 * @param {string|undefined} value The cell.
 * @returns {Date|null} A timestamp, or null.
 */
function toStamp(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const lowered = text.toLowerCase();
  if (['no', 'false', '0', ''].includes(lowered)) return null;
  if (['yes', 'true', '1', 'checked', 'x'].includes(lowered)) return new Date(0);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * @param {object} document A `cohorts` document.
 * @returns {object} The dashboard projection.
 */
export function toCohortResponse(document) {
  return {
    id: document._id,
    name: document.name,
    type: document.type,
    organizationName: document.organizationName ?? null,
    targetSize: toInteger(document.targetSize),
    questionnaireId: document.questionnaireId ?? null,
    manuscriptEdition: document.manuscriptEdition ?? null,
    status: document.status,
    notes: document.notes ?? null,
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

/**
 * @param {object} document An `invitations` document.
 * @returns {object} The dashboard projection. Carries no session reference.
 */
export function toInvitationResponse(document) {
  return {
    id: document._id,
    cohortId: document.cohortId ?? null,
    code: document.code,
    email: document.email ?? null,
    displayName: document.displayName ?? null,
    country: document.country ?? null,
    preferredLanguage: document.preferredLanguage ?? null,
    occupationBackground: document.occupationBackground ?? null,
    source: document.source ?? null,
    status: document.status,
    redeemedAt: toIso(document.redeemedAt),
    welcomeEmailSentAt: toIso(document.welcomeEmailSentAt),
    readingLinkSentAt: toIso(document.readingLinkSentAt),
    sentAt: toIso(document.sentAt),
    // Internal operational counter, never rendered to a reader (§14.4.4 governs the reader
    // experience, not a coordinator's queue).
    sendCount: toInteger(document.sendCount, 0),
    lastError: document.lastError ?? null,
    revokedAt: toIso(document.revokedAt),
    notes: document.notes ?? null,
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, mailer?: object }}
 *        deps Dependencies.
 * @returns {object} The admin beta service.
 */
export function createAdminBetaService({ db, config, logger = null, mailer = null }) {
  const cohorts = db.collection(COLLECTIONS.COHORTS);
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const mail = mailer ?? createMailer({ logger });

  /**
   * @param {string} id A cohort `_id`.
   * @returns {Promise<object>} The cohort.
   * @throws {ApiError} 404 when it does not exist.
   */
  async function requireCohort(id) {
    const cohort = await cohorts.findOne({ _id: id });
    if (!cohort) throw new ApiError(404, 'NOT_FOUND', 'That cohort does not exist.');
    return cohort;
  }

  /**
   * Count the funnel for one cohort, in a single pass.
   *
   * @param {string} cohortId The cohort identifier.
   * @returns {Promise<object>} The funnel counts.
   */
  async function funnelFor(cohortId) {
    const [row] = await invitations
      .aggregate([
        { $match: { cohortId } },
        {
          $group: {
            _id: null,
            interested: { $sum: 1 },
            approved: { $sum: { $cond: [{ $in: ['$status', [...APPROVED_OR_LATER]] }, 1, 0] } },
            linkSent: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $in: ['$status', [...LINK_SENT_OR_LATER]] },
                      { $ne: [{ $ifNull: ['$readingLinkSentAt', null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            redeemed: { $sum: { $cond: [{ $in: ['$status', [...REDEEMED_OR_LATER]] }, 1, 0] } },
            questionnaireCompleted: {
              $sum: { $cond: [{ $eq: ['$status', 'questionnaire_completed'] }, 1, 0] },
            },
            followUpNeeded: { $sum: { $cond: [{ $eq: ['$status', 'follow_up_needed'] }, 1, 0] } },
            notSelected: { $sum: { $cond: [{ $eq: ['$status', 'not_selected'] }, 1, 0] } },
          },
        },
      ])
      .toArray();

    return {
      interested: row?.interested ?? 0,
      approved: row?.approved ?? 0,
      linkSent: row?.linkSent ?? 0,
      redeemed: row?.redeemed ?? 0,
      questionnaireCompleted: row?.questionnaireCompleted ?? 0,
      followUpNeeded: row?.followUpNeeded ?? 0,
      notSelected: row?.notSelected ?? 0,
    };
  }

  return {
    funnelFor,

    /* -------------------------------- cohorts -------------------------------- */

    /**
     * @param {object} query The validated query string.
     * @returns {Promise<{ cohorts: object[], total: number }>} The listing.
     */
    async listCohorts(query = {}) {
      const filter = {};
      if (query.status) filter.status = query.status;
      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        cohorts.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        cohorts.countDocuments(filter),
      ]);
      return { cohorts: documents.map(toCohortResponse), total: count };
    },

    /**
     * @param {object} admin The acting administrator.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ cohort: object }>} The created cohort.
     */
    async createCohort(admin, input, options = {}) {
      const now = new Date();
      const document = {
        _id: newId(),
        name: input.name,
        type: input.type,
        organizationName: input.organizationName ?? null,
        targetSize: toInteger(input.targetSize),
        questionnaireId: input.questionnaireId ?? null,
        manuscriptEdition: input.manuscriptEdition ?? null,
        status: 'planned',
        notes: input.notes ?? null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await cohorts.insertOne(document);
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(409, 'CONFLICT', 'A cohort with that name already exists.');
        }
        throw error;
      }

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: BETA_AUDIT_ACTIONS.COHORT_CREATE,
        targetCollection: COLLECTIONS.COHORTS,
        targetId: document._id,
        after: { name: document.name, type: document.type },
        correlationId: options.correlationId ?? null,
      });

      return { cohort: toCohortResponse(document) };
    },

    /**
     * @param {object} admin The acting administrator.
     * @param {string} id The cohort identifier.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ cohort: object }>} The updated cohort.
     */
    async updateCohort(admin, id, input, options = {}) {
      const cohort = await requireCohort(id);
      const now = new Date();
      const set = { ...updateStamps(now) };
      for (const key of [
        'name',
        'organizationName',
        'targetSize',
        'questionnaireId',
        'manuscriptEdition',
        'status',
        'notes',
      ]) {
        if (key in input) set[key] = input[key];
      }

      const updated = await cohorts.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.COHORT_UPDATE,
        targetCollection: COLLECTIONS.COHORTS,
        targetId: id,
        before: { status: cohort.status, name: cohort.name },
        after: { fields: Object.keys(set).filter((key) => key !== 'updatedAt') },
        correlationId: options.correlationId ?? null,
      });

      return { cohort: toCohortResponse(updated) };
    },

    /**
     * `GET /admin/cohorts/:id/summary`.
     *
     * @param {string} id The cohort identifier.
     * @returns {Promise<object>} The cohort funnel.
     */
    async cohortSummary(id) {
      const cohort = await requireCohort(id);
      return {
        cohortId: cohort._id,
        name: cohort.name,
        targetSize: toInteger(cohort.targetSize),
        funnel: await funnelFor(id),
      };
    },

    /* ------------------------------ invitations ------------------------------ */

    /**
     * `GET /admin/invitations?cohortId&status&q&page` — the invitation status list.
     *
     * `q` matches an address, a name or a code. It is a regular expression rather than a
     * text index because the search a coordinator actually performs is "the person who wrote
     * to us last week, something with a k in it" over a collection sized 50–200 (§5.7), and a
     * text index would answer that worse.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<{ invitations: object[], total: number }>} The listing.
     */
    async listInvitations(query = {}) {
      const filter = {};
      if (query.cohortId) filter.cohortId = query.cohortId;
      if (query.status) filter.status = query.status;
      if (typeof query.q === 'string' && query.q.trim() !== '') {
        const needle = new RegExp(escapeRegExp(query.q.trim()), 'i');
        filter.$or = [
          { email: { $regex: needle } },
          { displayName: { $regex: needle } },
          { code: { $regex: needle } },
        ];
      }

      const limit = query.limit ?? 50;
      // `page` is the dashboard's vocabulary and `offset` is the API's. A page wins when both
      // arrive, because a client that sends a page number is paging.
      const skip = Number.isInteger(query.page) && query.page > 0
        ? (query.page - 1) * limit
        : query.offset ?? 0;

      const [documents, count] = await Promise.all([
        invitations.find(filter, { sort: { createdAt: -1 }, limit, skip }).toArray(),
        invitations.countDocuments(filter),
      ]);
      return { invitations: documents.map(toInvitationResponse), total: count };
    },

    /**
     * @param {object} admin The acting administrator.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ invitation: object }>} The created invitation.
     */
    async createInvitation(admin, input, options = {}) {
      const now = new Date();
      const document = {
        _id: newId(),
        cohortId: input.cohortId ?? null,
        code: mintInvitationCode(),
        email: input.email.trim().toLowerCase(),
        displayName: input.displayName ?? null,
        country: input.country ?? null,
        preferredLanguage: input.preferredLanguage ?? null,
        occupationBackground: input.occupationBackground ?? null,
        source: input.source ?? null,
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
        notes: input.notes ?? null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      await invitations.insertOne(document);

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.INVITATION_CREATE,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: document._id,
        after: { cohortId: document.cohortId, status: document.status },
        correlationId: options.correlationId ?? null,
      });

      return { invitation: toInvitationResponse(document) };
    },

    /**
     * @param {object} admin The acting administrator.
     * @param {string} id The invitation identifier.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ invitation: object }>} The updated invitation.
     */
    async updateInvitation(admin, id, input, options = {}) {
      const invitation = await invitations.findOne({ _id: id });
      if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'That invitation does not exist.');

      const now = new Date();
      const set = { ...updateStamps(now) };
      for (const key of [
        'cohortId',
        'displayName',
        'country',
        'preferredLanguage',
        'occupationBackground',
        'status',
        'notes',
      ]) {
        if (key in input) set[key] = input[key];
      }

      const updated = await invitations.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: BETA_AUDIT_ACTIONS.INVITATION_UPDATE,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: id,
        before: { status: invitation.status },
        after: { fields: Object.keys(set).filter((key) => key !== 'updatedAt') },
        correlationId: options.correlationId ?? null,
      });

      return { invitation: toInvitationResponse(updated) };
    },

    /**
     * `POST /admin/invitations/:id/send-welcome`.
     *
     * The welcome carries the private reading link, so both funnel stamps advance together.
     * The manuscript is never attached — a private link only (§14.4.5). A participant who
     * already holds their link is not messaged again.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The invitation identifier.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ invitation: object, delivered: boolean }>} The result.
     */
    async sendWelcome(admin, id, options = {}) {
      const invitation = await invitations.findOne({ _id: id });
      if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'That invitation does not exist.');
      if (typeof invitation.email !== 'string' || invitation.email === '') {
        throw new ApiError(422, 'NO_ADDRESS', 'That invitation has no address to write to.');
      }
      if (WELCOMED_STATUSES.includes(invitation.status)) {
        // Not an error, and not a second message. The state is already what was asked for.
        return { invitation: toInvitationResponse(invitation), delivered: false };
      }

      const cohort = invitation.cohortId
        ? await cohorts.findOne({ _id: invitation.cohortId }, { projection: { name: 1 } })
        : null;

      // Tokenised per participant so completion tracking is automatic and a leaked link is
      // individually revocable (§10.7.2).
      const readingUrl = buildInvitationUrl(config, invitation.code);

      let delivered = false;
      try {
        const result = await mail.sendTemplate('beta_welcome', invitation.email, {
          displayName: invitation.displayName ?? null,
          readingUrl,
          cohortName: cohort?.name ?? null,
        });
        delivered = result?.delivered === true;
      } catch (error) {
        logger?.error?.({ err: error, invitationId: id }, 'welcome message could not be sent');
        throw new ApiError(
          503,
          'MAIL_UNAVAILABLE',
          'The message could not be sent. Nothing was changed.',
        );
      }

      const now = new Date();
      const updated = await invitations.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: 'reading_link_sent',
            welcomeEmailSentAt: now,
            readingLinkSentAt: now,
            ...updateStamps(now),
          },
        },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.INVITATION_SEND_WELCOME,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: id,
        before: { status: invitation.status },
        after: { status: 'reading_link_sent', delivered },
        correlationId: options.correlationId ?? null,
      });

      return { invitation: toInvitationResponse(updated), delivered };
    },

    /**
     * `POST /admin/beta/import` — the one-way Airtable bridge.
     *
     * @param {object} admin The acting administrator.
     * @param {{ cohortId?: string, csv: string }} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ imported: number, updated: number, skipped: number,
     *                     errors: string[] }>} The import summary.
     */
    async importInvitations(admin, input, options = {}) {
      if (input.cohortId) await requireCohort(input.cohortId);

      const rows = parseCsv(input.csv);
      if (rows.length < 2) {
        throw new ApiError(422, 'EMPTY_IMPORT', 'That file has no rows to import.');
      }

      const headers = rows[0].map((heading) => {
        const key = heading.toLowerCase().replace(/[^a-z]/g, '');
        return CSV_COLUMN_MAP[key] ?? null;
      });
      if (!headers.includes('email')) {
        throw new ApiError(422, 'NO_EMAIL_COLUMN', 'That file has no Email column.');
      }

      const summary = { imported: 0, updated: 0, skipped: 0, errors: [] };
      const now = new Date();

      for (let index = 1; index < rows.length; index += 1) {
        const cells = rows[index];
        const record = {};
        for (let column = 0; column < headers.length; column += 1) {
          const field = headers[column];
          if (field) record[field] = (cells[column] ?? '').trim();
        }

        const address = String(record.email ?? '').trim().toLowerCase();
        if (address === '' || !address.includes('@')) {
          summary.skipped += 1;
          if (summary.errors.length < 50) summary.errors.push(`Row ${index + 1}: no address.`);
          continue;
        }

        const displayName =
          record.displayName ||
          [record.firstName, record.lastName].filter((part) => part).join(' ') ||
          null;
        const status =
          AIRTABLE_STATUS_MAP[String(record.status ?? '').trim().toLowerCase()] ?? 'new_interest';
        const source = SOURCE_VALUES.includes(String(record.source ?? '').toLowerCase())
          ? String(record.source).toLowerCase()
          : null;

        const set = {
          displayName,
          country: record.country || null,
          preferredLanguage: record.preferredLanguage || null,
          occupationBackground: record.occupationBackground || null,
          source,
          notes: record.notes || null,
          ...updateStamps(now),
        };
        if (input.cohortId) set.cohortId = input.cohortId;

        const welcomeStamp = toStamp(record.welcomeEmailSent);
        const linkStamp = toStamp(record.readingLinkSent);
        if (welcomeStamp) set.welcomeEmailSentAt = welcomeStamp;
        if (linkStamp) set.readingLinkSentAt = linkStamp;

        try {
          const existing = await invitations.findOne({ email: address });
          if (existing) {
            // Never walk a participant backwards: an import is a mirror of an older system,
            // and the platform's own record of a redemption is the newer truth.
            const currentRank = APPROVED_OR_LATER.indexOf(existing.status);
            const incomingRank = APPROVED_OR_LATER.indexOf(status);
            if (incomingRank > currentRank) set.status = status;
            await invitations.updateOne({ _id: existing._id }, { $set: set });
            summary.updated += 1;
          } else {
            await invitations.insertOne({
              _id: newId(),
              cohortId: input.cohortId ?? null,
              code: mintInvitationCode(),
              email: address,
              displayName: set.displayName,
              country: set.country,
              preferredLanguage: set.preferredLanguage,
              occupationBackground: set.occupationBackground,
              source,
              status,
              redeemedBySessionId: null,
              redeemedAt: null,
              welcomeEmailSentAt: set.welcomeEmailSentAt ?? null,
              readingLinkSentAt: set.readingLinkSentAt ?? null,
              notes: set.notes,
              ...creationStamps(SCHEMA_VERSION, now),
            });
            summary.imported += 1;
          }
        } catch (error) {
          summary.skipped += 1;
          if (summary.errors.length < 50) {
            summary.errors.push(`Row ${index + 1}: ${error?.code ?? 'write failed'}.`);
          }
        }
      }

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: BETA_AUDIT_ACTIONS.INVITATION_IMPORT,
        targetCollection: COLLECTIONS.INVITATIONS,
        targetId: input.cohortId ?? null,
        after: {
          imported: summary.imported,
          updated: summary.updated,
          skipped: summary.skipped,
        },
        correlationId: options.correlationId ?? null,
      });

      return summary;
    },
  };
}

export default createAdminBetaService;
