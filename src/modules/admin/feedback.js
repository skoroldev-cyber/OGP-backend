/**
 * Questionnaire administration, response review, and the free-form feedback queue.
 *
 * The instrument is Questionnaire v2.0, reached from the reading page's exact button
 * "Continue to Observations" (§10.7.3). This module manages the instrument and lists what
 * came back; it does not score, rank, or profile anybody.
 *
 * Responses are the one place free text from a human is stored and read by staff. They exist
 * under study consent, they are listed by cohort rather than by person, and nothing in this
 * module joins a response to a reading trail — the response carries a severable `sessionId`
 * which is not projected here, exactly as the invitation projection omits its own.
 *
 * Only one questionnaire is active at a time. Activating a new version archives the old one
 * in the same operation, so a reader can never be handed two live instruments.
 *
 * The **free-form feedback queue** obeys the same two constraints as everything else on this
 * surface. `sessionId` is never projected, so a reviewer reads what a person wrote and never
 * where they were in the manuscript. And the summary is an aggregate — counts by category,
 * by triage state and by unit — never a per-reader profile: there is no group-by-session
 * anywhere in this file and no shape that could carry one (§10.2).
 */

import {
  DEFAULT_FEEDBACK_STATUS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  RATED_QUESTION_KINDS,
  RATING_MAX,
  RATING_MIN,
  READING_FORMATS,
  SCHEMA_VERSION,
} from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

/** Audit actions this module writes that `lib/audit.js` does not already name. */
export const FEEDBACK_AUDIT_ACTIONS = Object.freeze({
  QUESTIONNAIRE_CREATE: 'questionnaire.create',
  QUESTIONNAIRE_UPDATE: 'questionnaire.update',
  FEEDBACK_UPDATE: 'feedback.update',
  FEEDBACK_EXPORT: 'feedback.export',
  RESPONSES_EXPORT: 'questionnaire_responses.export',
});

/** Hard ceiling on one listing page and on one export. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 5000;

/** Widest unit breakdown the summary will return. Beyond this it is not a summary. */
const MAX_SUMMARY_UNITS = 200;

/**
 * @param {object} document A `questionnaires` document.
 * @returns {object} The dashboard projection.
 */
export function toQuestionnaireResponse(document) {
  return {
    id: document._id,
    title: document.title,
    version: document.version,
    status: document.status,
    purpose: document.purpose ?? null,
    instruction: document.instruction ?? null,
    scaleLegend: document.scaleLegend ?? null,
    sections: (Array.isArray(document.sections) ? document.sections : []).map((section) => ({
      key: section.key,
      title: section.title,
      description: section.description ?? null,
    })),
    questions: (Array.isArray(document.questions) ? document.questions : []).map((question) => ({
      questionId: question.questionId,
      order: question.order,
      kind: question.kind,
      prompt: question.prompt,
      label: question.label ?? null,
      section: question.section ?? null,
      scaleLegend: question.scaleLegend ?? null,
      role: question.role ?? null,
      options: Array.isArray(question.options) ? question.options : null,
      required: question.required === true,
    })),
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

/**
 * @param {object} document A `questionnaire_responses` document.
 * @returns {object} The dashboard projection. No session reference.
 */
export function toResponseProjection(document) {
  const reviewer = document.reviewer ?? null;
  return {
    id: document._id,
    questionnaireId: document.questionnaireId,
    cohortId: document.cohortId ?? null,
    invitationId: document.invitationId ?? null,
    readingFormat: document.readingFormat ?? null,
    completedAt: toIso(document.completedAt),
    reviewer: {
      name: reviewer?.name ?? null,
      completedOn: reviewer?.completedOn ?? null,
      readingTime: reviewer?.readingTime ?? null,
      // Tri-state, and it stays tri-state all the way to the screen. `false` is a reviewer
      // who declined; `null` is a reviewer who was never asked or did not answer. Rendering
      // both as "No" would be safe; rendering both as "not answered" would not.
      quoteConsent: typeof reviewer?.quoteConsent === 'boolean' ? reviewer.quoteConsent : null,
    },
    answers: (Array.isArray(document.answers) ? document.answers : []).map((answer) => ({
      questionId: answer.questionId,
      text: answer.text ?? null,
      rating: Number.isFinite(answer.rating) ? Number(answer.rating) : null,
      values: Array.isArray(answer.values) ? answer.values.map(String) : [],
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Free-form feedback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The reviewer's view of one feedback record.
 *
 * `sessionId` is absent, as it is from every other projection on this surface. `email` is
 * absent from the document itself unless the reader consented to contact, so nothing has to
 * remember to strip it here.
 *
 * @param {object} document A `feedback` document.
 * @returns {object} The dashboard projection.
 */
export function toFeedbackProjection(document) {
  return {
    id: document._id,
    kind: document.kind,
    category: document.category,
    status: document.status ?? DEFAULT_FEEDBACK_STATUS,
    body: document.body,
    displayName: document.displayName ?? null,
    email: document.contactConsent === true ? document.email ?? null : null,
    contactConsent: document.contactConsent === true,
    passages: (Array.isArray(document.passages) ? document.passages : []).map((passage) => ({
      unitId: passage.unitId,
      componentIndex: Number.isInteger(passage.componentIndex) ? passage.componentIndex : null,
      excerpt: passage.excerpt ?? null,
      charStart: Number.isInteger(passage.charStart) ? passage.charStart : null,
      charEnd: Number.isInteger(passage.charEnd) ? passage.charEnd : null,
    })),
    releaseId: document.releaseId ?? null,
    readingFormat: document.readingFormat ?? null,
    cohortId: document.cohortId ?? null,
    invitationId: document.invitationId ?? null,
    adminNotes: document.adminNotes ?? null,
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

/**
 * Escape one CSV field per RFC 4180 §2.6–2.7: a field containing a comma, a quote, CR or LF
 * is wrapped in quotes, and every embedded quote is doubled. Reader feedback is free text
 * and routinely contains all four.
 *
 * @param {unknown} value The field value.
 * @returns {string} The escaped field.
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Render rows as an RFC 4180 document. CRLF line endings, per §2.1, and a trailing CRLF so
 * the last record is terminated like every other one.
 *
 * @param {Array<Array<unknown>>} rows Header row first.
 * @returns {string} The CSV document.
 */
export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

/**
 * The export columns, in order. Documented here because a spreadsheet is the one consumer
 * that cannot ask what a column means.
 *
 * `display_name` and `email` are blank unless the reader gave contact consent. A CSV leaves
 * the platform — it is mailed, dropped into a shared drive, opened on a laptop — so the
 * consent question is answered at the boundary, not by whoever opens the file.
 */
export const FEEDBACK_EXPORT_COLUMNS = Object.freeze([
  'id', // ULID of the feedback record
  'submitted_at', // ISO-8601 UTC
  'status', // new | triaged | actioned | archived
  'category', // one of FEEDBACK_CATEGORIES
  'kind', // general | passage
  'cohort_id', // beta cohort, when the reader arrived through an invitation
  'reading_format', // §5.8 vocabulary; 'immersive room' for the reading room
  'release_id', // the release the character offsets were taken against
  'passage_unit_ids', // space-separated unit ids the feedback is anchored to
  'passage_excerpts', // the marked text, one excerpt per line within the cell
  'body', // what the reader wrote
  'contact_consent', // true | false
  'display_name', // blank without contact consent
  'email', // blank without contact consent
  'admin_notes', // triage notes
]);

/**
 * @param {object} document A `feedback` document.
 * @returns {Array<unknown>} One export row, aligned with {@link FEEDBACK_EXPORT_COLUMNS}.
 */
function toExportRow(document) {
  const passages = Array.isArray(document.passages) ? document.passages : [];
  const consented = document.contactConsent === true;
  return [
    document._id,
    toIso(document.createdAt),
    document.status ?? DEFAULT_FEEDBACK_STATUS,
    document.category,
    document.kind,
    document.cohortId ?? '',
    document.readingFormat ?? '',
    document.releaseId ?? '',
    passages.map((passage) => passage.unitId).join(' '),
    passages
      .map((passage) => passage.excerpt)
      .filter((excerpt) => typeof excerpt === 'string' && excerpt !== '')
      .join('\n'),
    document.body,
    consented ? 'true' : 'false',
    consented ? document.displayName ?? '' : '',
    consented ? document.email ?? '' : '',
    document.adminNotes ?? '',
  ];
}

/**
 * A regular expression that matches the literal text a reviewer typed. Free-text search over
 * reader feedback must not let a stray `(` or `*` become an operator.
 *
 * @param {string} text The search text.
 * @returns {RegExp} A case-insensitive literal matcher.
 */
function literalMatcher(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * The fixed leading columns of a questionnaire response export. The question columns are
 * appended after these, one per question, from the instrument itself.
 */
export const RESPONSE_EXPORT_COLUMNS = Object.freeze([
  'id', // ULID of the response
  'completed_at', // ISO-8601 UTC
  'questionnaire_id', // the instrument answered
  'cohort_id', // beta cohort, when the reviewer arrived through an invitation
  'reading_format', // DOCX | PDF | print | immersive room
  'reviewer', // the name or reviewer code they gave, if any
  'reviewer_date', // the date they recorded completing the reading
  'reading_time', // their own estimate, free text
  'quote_consent', // true | false | blank when unanswered
]);

/**
 * Build the Mongo filter for a response listing, summary or export.
 *
 * `q` searches the reviewer's prose across every answer. `elemMatch` rather than a dotted
 * path because a dotted path over an array matches a document where *any* element matches —
 * which is the same thing here, but only by accident, and stops being the same thing the
 * moment a second condition is added.
 *
 * @param {object} query The validated query string.
 * @returns {object} The filter.
 */
function responseFilter(query = {}) {
  const filter = {};
  if (query.cohortId) filter.cohortId = query.cohortId;
  if (query.questionnaireId) filter.questionnaireId = query.questionnaireId;
  if (query.readingFormat) filter.readingFormat = query.readingFormat;

  if (query.quoteConsent === 'granted') filter['reviewer.quoteConsent'] = true;
  if (query.quoteConsent === 'declined') filter['reviewer.quoteConsent'] = false;
  if (query.quoteConsent === 'not_answered') {
    filter.$or = [{ 'reviewer.quoteConsent': null }, { 'reviewer.quoteConsent': { $exists: false } }];
  }

  if (typeof query.q === 'string' && query.q.trim() !== '') {
    filter.answers = { $elemMatch: { text: { $regex: literalMatcher(query.q.trim()) } } };
  }

  const completedAt = {};
  if (query.from) completedAt.$gte = new Date(query.from);
  if (query.to) completedAt.$lte = new Date(query.to);
  if (Object.keys(completedAt).length > 0) filter.completedAt = completedAt;

  return filter;
}

/**
 * Build the Mongo filter for a feedback listing, export or summary.
 *
 * @param {object} query The validated query string.
 * @returns {object} The filter.
 */
function feedbackFilter(query = {}) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (query.cohortId) filter.cohortId = query.cohortId;
  if (query.unitId) filter['passages.unitId'] = query.unitId;
  if (typeof query.q === 'string' && query.q.trim() !== '') {
    filter.body = { $regex: literalMatcher(query.q.trim()) };
  }

  const createdAt = {};
  if (query.from) createdAt.$gte = new Date(query.from);
  if (query.to) createdAt.$lte = new Date(query.to);
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

  return filter;
}

/**
 * Page geometry. `limit` and `page` arrive as digit strings (see `digits` in `./schemas.js`)
 * and are converted here, which is also where the ceilings are applied.
 *
 * @param {object} query The validated query string.
 * @returns {{ limit: number, skip: number, page: number }} Page geometry.
 */
function pageOf(query = {}) {
  const asCount = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const limit = Math.min(asCount(query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const page = asCount(query.page, 1);
  return { limit, skip: (page - 1) * limit, page };
}

/**
 * @param {{ db: import('mongodb').Db, logger?: object }} deps Dependencies.
 * @returns {object} The admin feedback service.
 */
export function createAdminFeedbackService({ db }) {
  const questionnaires = db.collection(COLLECTIONS.QUESTIONNAIRES);
  const responses = db.collection(COLLECTIONS.QUESTIONNAIRE_RESPONSES);
  const feedback = db.collection(COLLECTIONS.FEEDBACK);

  return {
    /**
     * @param {object} query The validated query string.
     * @returns {Promise<{ questionnaires: object[], total: number }>} The listing.
     */
    async listQuestionnaires(query = {}) {
      const filter = {};
      if (query.status) filter.status = query.status;
      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        questionnaires.find(filter, { sort: { version: -1 }, limit, skip }).toArray(),
        questionnaires.countDocuments(filter),
      ]);
      return { questionnaires: documents.map(toQuestionnaireResponse), total: count };
    },

    /**
     * A new questionnaire is created archived; activating it is a separate act, so an
     * instrument cannot reach a reader in the same request that authored it.
     *
     * @param {object} admin The acting administrator.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ questionnaire: object }>} The created questionnaire.
     */
    async createQuestionnaire(admin, input, options = {}) {
      assertCleanCopy(input.title, 'title');
      for (const question of input.questions) {
        assertCleanCopy(question.prompt, `questions.${question.questionId}.prompt`);
        for (const option of question.options ?? []) {
          assertCleanCopy(option, `questions.${question.questionId}.options`);
        }
      }

      const now = new Date();
      const document = {
        _id: newId(),
        title: input.title,
        version: input.version,
        status: 'archived',
        purpose: input.purpose ?? null,
        instruction: input.instruction ?? null,
        scaleLegend: input.scaleLegend ?? null,
        sections: (Array.isArray(input.sections) ? input.sections : []).map((section) => ({
          key: section.key,
          title: section.title,
          description: section.description ?? null,
        })),
        questions: input.questions.map((question) => ({
          questionId: question.questionId,
          order: question.order,
          kind: question.kind,
          prompt: question.prompt,
          label: question.label ?? null,
          section: question.section ?? null,
          scaleLegend: question.scaleLegend ?? null,
          role: question.role ?? null,
          options: Array.isArray(question.options) ? question.options : null,
          required: question.required === true,
        })),
        ...creationStamps(SCHEMA_VERSION, now),
      };

      await questionnaires.insertOne(document);

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: FEEDBACK_AUDIT_ACTIONS.QUESTIONNAIRE_CREATE,
        targetCollection: COLLECTIONS.QUESTIONNAIRES,
        targetId: document._id,
        after: { title: document.title, version: document.version, questions: document.questions.length },
        correlationId: options.correlationId ?? null,
      });

      return { questionnaire: toQuestionnaireResponse(document) };
    },

    /**
     * @param {object} admin The acting administrator.
     * @param {string} id The questionnaire identifier.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ questionnaire: object }>} The updated questionnaire.
     */
    async updateQuestionnaire(admin, id, input, options = {}) {
      const existing = await questionnaires.findOne({ _id: id });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'That questionnaire does not exist.');

      const now = new Date();
      const set = { ...updateStamps(now) };
      if ('title' in input) {
        assertCleanCopy(input.title, 'title');
        set.title = input.title;
      }
      if ('status' in input) set.status = input.status;

      if (set.status === 'active') {
        // Exactly one live instrument. The others are archived in the same breath.
        await questionnaires.updateMany(
          { _id: { $ne: id }, status: 'active' },
          { $set: { status: 'archived', ...updateStamps(now) } },
        );
      }

      const updated = await questionnaires.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: FEEDBACK_AUDIT_ACTIONS.QUESTIONNAIRE_UPDATE,
        targetCollection: COLLECTIONS.QUESTIONNAIRES,
        targetId: id,
        before: { status: existing.status },
        after: { fields: Object.keys(set).filter((key) => key !== 'updatedAt') },
        correlationId: options.correlationId ?? null,
      });

      return { questionnaire: toQuestionnaireResponse(updated) };
    },

    /**
     * `GET /admin/questionnaire-responses`.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<{ responses: object[], total: number }>} The listing.
     */
    async listResponses(query = {}) {
      const filter = responseFilter(query);
      const limit = query.limit ?? 50;
      const skip = query.offset ?? 0;
      const [documents, count] = await Promise.all([
        responses
          .find(filter, {
            // `sessionId` is severable and stays out of every response shape: a reviewer
            // reads what a participant wrote, never where they were in the manuscript.
            projection: { sessionId: 0 },
            sort: { completedAt: -1 },
            limit,
            skip,
          })
          .toArray(),
        responses.countDocuments(filter),
      ]);
      return { responses: documents.map(toResponseProjection), total: count };
    },

    /**
     * `GET /admin/questionnaire-responses/:id` — one returned instrument, in full.
     *
     * The instrument travels with it. A stored answer is a `questionId` and some text; on
     * its own that is unreadable, and worse, it is unreadable in a way that invites guessing.
     * Sending the questionnaire the answers were given against means the screen shows the
     * question each reviewer actually saw, including for a response returned against a
     * version that has since been archived and reworded.
     *
     * @param {string} id The response identifier.
     * @returns {Promise<{ response: object, questionnaire: object|null }>} The record.
     */
    async getResponse(id) {
      const document = await responses.findOne({ _id: id }, { projection: { sessionId: 0 } });
      if (!document) throw new ApiError(404, 'NOT_FOUND', 'That response does not exist.');

      const questionnaire = await questionnaires.findOne({ _id: document.questionnaireId });
      return {
        response: toResponseProjection(document),
        questionnaire: questionnaire ? toQuestionnaireResponse(questionnaire) : null,
      };
    },

    /**
     * `GET /admin/questionnaire-responses/summary`.
     *
     * Aggregate only, and aggregate in the shape the instrument is actually asked about:
     * how many responses, how they were read, whether they may be quoted, and — for the
     * five questions that carry a 1–5 rating — the distribution and the mean.
     *
     * The mean is reported alongside the distribution rather than instead of it. Five
     * reviewers splitting 1/1/5/5/5 average 3.4, which describes none of them; the histogram
     * is the finding and the average is the headline.
     *
     * Nothing here groups by session, invitation or person, and there is no shape in which
     * it could (§10.2).
     *
     * @param {object} query The validated query string.
     * @returns {Promise<object>} The aggregate summary.
     */
    async summariseResponses(query = {}) {
      const filter = responseFilter(query);

      const [total, byFormatRows, byConsentRows, ratingRows, instrument] = await Promise.all([
        responses.countDocuments(filter),
        responses
          .aggregate([{ $match: filter }, { $group: { _id: '$readingFormat', count: { $sum: 1 } } }])
          .toArray(),
        responses
          .aggregate([
            { $match: filter },
            { $group: { _id: '$reviewer.quoteConsent', count: { $sum: 1 } } },
          ])
          .toArray(),
        responses
          .aggregate([
            { $match: filter },
            { $unwind: '$answers' },
            { $match: { 'answers.rating': { $gte: RATING_MIN, $lte: RATING_MAX } } },
            {
              $group: {
                _id: { questionId: '$answers.questionId', rating: '$answers.rating' },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        query.questionnaireId
          ? questionnaires.findOne({ _id: query.questionnaireId })
          : questionnaires.findOne({ status: 'active' }, { sort: { version: -1 } }),
      ]);

      const formatCounts = new Map(byFormatRows.map((row) => [row._id, row.count]));
      const consentCount = (value) =>
        byConsentRows.find((row) => row._id === value)?.count ?? 0;

      // Every declared rating question appears, at zero if nobody answered it, so the
      // founder's view keeps a stable axis between one reading and the next.
      const rated = (Array.isArray(instrument?.questions) ? instrument.questions : [])
        .filter((question) => RATED_QUESTION_KINDS.includes(question.kind))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const byQuestion = rated.map((question) => {
        const distribution = [];
        let sum = 0;
        let answered = 0;
        for (let rating = RATING_MIN; rating <= RATING_MAX; rating += 1) {
          const count =
            ratingRows.find(
              (row) => row._id.questionId === question.questionId && row._id.rating === rating,
            )?.count ?? 0;
          distribution.push({ rating, count });
          sum += rating * count;
          answered += count;
        }
        return {
          questionId: question.questionId,
          label: question.label ?? null,
          prompt: question.prompt,
          answered,
          // Rounded to one place: a mean over a five-point scale reported to four decimals
          // claims a precision the instrument does not have.
          average: answered > 0 ? Math.round((sum / answered) * 10) / 10 : null,
          distribution,
        };
      });

      return {
        total,
        byReadingFormat: READING_FORMATS.map((format) => ({
          readingFormat: format,
          count: formatCounts.get(format) ?? 0,
        })),
        quoteConsent: {
          granted: consentCount(true),
          declined: consentCount(false),
          notAnswered: consentCount(null),
        },
        byQuestion,
      };
    },

    /**
     * `GET /admin/questionnaire-responses/export.csv`.
     *
     * One row per response, one column per question, so the file opens as the instrument
     * with the answers underneath it — which is the shape anybody analysing this will
     * otherwise spend an afternoon building by hand. Compound answers occupy two columns
     * (`<id>_rating`, `<id>`) rather than being flattened into one string, so the ratings
     * stay numeric in a spreadsheet.
     *
     * Capped at {@link MAX_EXPORT_ROWS}, and audited: an export moves a reviewer's written
     * words, and in some cases the name they gave, out of the platform.
     *
     * @param {object} admin The acting administrator.
     * @param {object} query The validated query string.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ csv: string, rows: number }>} The RFC 4180 document.
     */
    async exportResponsesCsv(admin, query = {}, options = {}) {
      const filter = responseFilter(query);
      const [documents, instrument] = await Promise.all([
        responses
          .find(filter, {
            projection: { sessionId: 0 },
            sort: { completedAt: -1 },
            limit: MAX_EXPORT_ROWS,
          })
          .toArray(),
        query.questionnaireId
          ? questionnaires.findOne({ _id: query.questionnaireId })
          : questionnaires.findOne({ status: 'active' }, { sort: { version: -1 } }),
      ]);

      const questions = (Array.isArray(instrument?.questions) ? instrument.questions : [])
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const header = [...RESPONSE_EXPORT_COLUMNS];
      for (const question of questions) {
        if (RATED_QUESTION_KINDS.includes(question.kind)) {
          header.push(`${question.questionId}_rating`);
        }
        header.push(question.questionId);
      }

      const rows = documents.map((document) => {
        const answers = new Map(
          (Array.isArray(document.answers) ? document.answers : []).map((answer) => [
            answer.questionId,
            answer,
          ]),
        );
        const reviewer = document.reviewer ?? {};
        const row = [
          document._id,
          toIso(document.completedAt),
          document.questionnaireId ?? '',
          document.cohortId ?? '',
          document.readingFormat ?? '',
          reviewer.name ?? '',
          reviewer.completedOn ?? '',
          reviewer.readingTime ?? '',
          typeof reviewer.quoteConsent === 'boolean' ? String(reviewer.quoteConsent) : '',
        ];
        for (const question of questions) {
          const answer = answers.get(question.questionId);
          if (RATED_QUESTION_KINDS.includes(question.kind)) {
            row.push(Number.isFinite(answer?.rating) ? String(answer.rating) : '');
          }
          const values = Array.isArray(answer?.values) ? answer.values : [];
          const text = answer?.text ?? '';
          row.push(values.length > 0 && text !== '' ? `${values.join('; ')}\n${text}`
            : values.length > 0 ? values.join('; ')
            : text);
        }
        return row;
      });

      const csv = toCsv([header, ...rows]);

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: FEEDBACK_AUDIT_ACTIONS.RESPONSES_EXPORT,
        targetCollection: COLLECTIONS.QUESTIONNAIRE_RESPONSES,
        after: { rows: documents.length, filters: Object.keys(filter) },
        correlationId: options.correlationId ?? null,
      });

      return { csv, rows: documents.length };
    },

    /* ---------------------------------------------------------------- */
    /* Free-form feedback                                                */
    /* ---------------------------------------------------------------- */

    /**
     * `GET /admin/feedback`. Filterable by triage state, category, cohort, marked unit,
     * free-text and date range; paged, newest first.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<{ feedback: object[], total: number, page: number }>} The listing.
     */
    async listFeedback(query = {}) {
      const filter = feedbackFilter(query);
      const { limit, skip, page } = pageOf(query);
      const [documents, count] = await Promise.all([
        feedback
          // `sessionId` never leaves the database on this surface.
          .find(filter, { projection: { sessionId: 0 }, sort: { createdAt: -1 }, limit, skip })
          .toArray(),
        feedback.countDocuments(filter),
      ]);
      return { feedback: documents.map(toFeedbackProjection), total: count, page };
    },

    /**
     * `GET /admin/feedback/:id`.
     *
     * @param {string} id The feedback identifier.
     * @returns {Promise<{ feedback: object }>} The record.
     */
    async getFeedback(id) {
      const document = await feedback.findOne({ _id: id }, { projection: { sessionId: 0 } });
      if (!document) throw new ApiError(404, 'NOT_FOUND', 'That feedback does not exist.');
      return { feedback: toFeedbackProjection(document) };
    },

    /**
     * `PATCH /admin/feedback/:id` — triage state and reviewer notes, nothing else.
     *
     * What a reader wrote is immutable here: `body`, `category`, `passages` and the contact
     * fields are not accepted by the schema and are not touched by this method. A review
     * queue that could edit the evidence would not be a record of what readers said.
     *
     * @param {object} admin The acting administrator.
     * @param {string} id The feedback identifier.
     * @param {object} input The validated body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ feedback: object }>} The updated record.
     */
    async updateFeedback(admin, id, input = {}, options = {}) {
      const existing = await feedback.findOne({ _id: id }, { projection: { sessionId: 0 } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'That feedback does not exist.');

      const now = new Date();
      const set = { ...updateStamps(now) };
      if ('status' in input && FEEDBACK_STATUSES.includes(input.status)) set.status = input.status;
      if ('adminNotes' in input) set.adminNotes = input.adminNotes === '' ? null : input.adminNotes;

      const updated = await feedback.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after', projection: { sessionId: 0 } },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: FEEDBACK_AUDIT_ACTIONS.FEEDBACK_UPDATE,
        targetCollection: COLLECTIONS.FEEDBACK,
        targetId: id,
        before: { status: existing.status ?? null },
        // The reader's words are not copied into the audit trail: the trail records who
        // changed the triage state, not what the feedback said.
        after: { status: set.status ?? existing.status ?? null, notesChanged: 'adminNotes' in set },
        correlationId: options.correlationId ?? null,
      });

      return { feedback: toFeedbackProjection(updated) };
    },

    /**
     * `GET /admin/feedback/summary` — counts by category, by triage state, and by the unit a
     * passage was marked in.
     *
     * **Aggregate only.** Every category and every status is returned even at zero, so the
     * founder's view has a stable axis, and nothing here groups by session, invitation or
     * person. The unit breakdown answers "which passages are readers stopping at", which is
     * a fact about the manuscript; there is no shape in which it becomes a fact about a
     * reader.
     *
     * @param {object} query The validated query string.
     * @returns {Promise<object>} The aggregate summary.
     */
    async summariseFeedback(query = {}) {
      const filter = feedbackFilter(query);

      const [byCategoryRows, byStatusRows, total] = await Promise.all([
        feedback.aggregate([{ $match: filter }, { $group: { _id: '$category', count: { $sum: 1 } } }]).toArray(),
        feedback.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        feedback.countDocuments(filter),
      ]);

      const counted = (rows) => new Map(rows.map((row) => [row._id, row.count]));
      const categoryCounts = counted(byCategoryRows);
      const statusCounts = counted(byStatusRows);

      // The unit tally is computed here rather than with `$unwind` because one submission
      // may mark several passages and must count once against each of them; the passage
      // arrays are short and the filter already bounds the scan.
      const anchored = await feedback
        .find(filter, { projection: { passages: 1 } })
        .toArray();
      const unitCounts = new Map();
      for (const document of anchored) {
        const units = new Set(
          (Array.isArray(document.passages) ? document.passages : [])
            .map((passage) => passage.unitId)
            .filter((unitId) => typeof unitId === 'string'),
        );
        for (const unitId of units) unitCounts.set(unitId, (unitCounts.get(unitId) ?? 0) + 1);
      }

      return {
        total,
        byCategory: FEEDBACK_CATEGORIES.map((category) => ({
          category,
          count: categoryCounts.get(category) ?? 0,
        })),
        byStatus: FEEDBACK_STATUSES.map((status) => ({
          status,
          count: statusCounts.get(status) ?? 0,
        })),
        byUnit: [...unitCounts.entries()]
          .map(([unitId, count]) => ({ unitId, count }))
          .sort((a, b) => b.count - a.count || a.unitId.localeCompare(b.unitId))
          .slice(0, MAX_SUMMARY_UNITS),
      };
    },

    /**
     * `GET /admin/feedback/export.csv`.
     *
     * Capped at {@link MAX_EXPORT_ROWS} newest records. The audit entry records how many rows
     * actually left, so a capped export is visible in the trail rather than being a silent
     * difference between the file and the queue.
     *
     * @param {object} admin The acting administrator.
     * @param {object} query The validated query string.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ csv: string, rows: number }>} The RFC 4180 document.
     */
    async exportFeedbackCsv(admin, query = {}, options = {}) {
      const filter = feedbackFilter(query);
      const documents = await feedback
        .find(filter, { projection: { sessionId: 0 }, sort: { createdAt: -1 }, limit: MAX_EXPORT_ROWS })
        .toArray();

      const csv = toCsv([[...FEEDBACK_EXPORT_COLUMNS], ...documents.map(toExportRow)]);

      // An export moves reader words — and, with consent, contact details — out of the
      // platform. Who did that, and how much of it, is exactly what an audit trail is for.
      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: FEEDBACK_AUDIT_ACTIONS.FEEDBACK_EXPORT,
        targetCollection: COLLECTIONS.FEEDBACK,
        after: { rows: documents.length, filters: Object.keys(filter) },
        correlationId: options.correlationId ?? null,
      });

      return { csv, rows: documents.length };
    },
  };
}

export default createAdminFeedbackService;
