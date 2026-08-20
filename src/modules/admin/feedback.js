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
import { toPaging } from '../../lib/schemas.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

export const FEEDBACK_AUDIT_ACTIONS = Object.freeze({
  QUESTIONNAIRE_CREATE: 'questionnaire.create',
  QUESTIONNAIRE_UPDATE: 'questionnaire.update',
  FEEDBACK_UPDATE: 'feedback.update',
  FEEDBACK_EXPORT: 'feedback.export',
  RESPONSES_EXPORT: 'questionnaire_responses.export',
});

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 5000;

const MAX_SUMMARY_UNITS = 200;

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

export function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + (rows.length > 0 ? '\r\n' : '');
}

export const FEEDBACK_EXPORT_COLUMNS = Object.freeze([
  'id',
  'submitted_at',
  'status',
  'category',
  'kind',
  'cohort_id',
  'reading_format',
  'release_id',
  'passage_unit_ids',
  'passage_excerpts',
  'body',
  'contact_consent',
  'display_name',
  'email',
  'admin_notes',
]);

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

function literalMatcher(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export const RESPONSE_EXPORT_COLUMNS = Object.freeze([
  'id',
  'completed_at',
  'questionnaire_id',
  'cohort_id',
  'reading_format',
  'reviewer',
  'reviewer_date',
  'reading_time',
  'quote_consent',
]);

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

function pageOf(query = {}) {
  const asCount = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const limit = Math.min(asCount(query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const page = asCount(query.page, 1);
  return { limit, skip: (page - 1) * limit, page };
}

export function createAdminFeedbackService({ db }) {
  const questionnaires = db.collection(COLLECTIONS.QUESTIONNAIRES);
  const responses = db.collection(COLLECTIONS.QUESTIONNAIRE_RESPONSES);
  const feedback = db.collection(COLLECTIONS.FEEDBACK);

  return {
    async listQuestionnaires(query = {}) {
      const filter = {};
      if (query.status) filter.status = query.status;
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        questionnaires.find(filter, { sort: { version: -1 }, limit, skip }).toArray(),
        questionnaires.countDocuments(filter),
      ]);
      return { questionnaires: documents.map(toQuestionnaireResponse), total: count };
    },

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

    async listResponses(query = {}) {
      const filter = responseFilter(query);
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        responses
          .find(filter, {
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

    async getResponse(id) {
      const document = await responses.findOne({ _id: id }, { projection: { sessionId: 0 } });
      if (!document) throw new ApiError(404, 'NOT_FOUND', 'That response does not exist.');

      const questionnaire = await questionnaires.findOne({ _id: document.questionnaireId });
      return {
        response: toResponseProjection(document),
        questionnaire: questionnaire ? toQuestionnaireResponse(questionnaire) : null,
      };
    },

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

    async listFeedback(query = {}) {
      const filter = feedbackFilter(query);
      const { limit, skip, page } = pageOf(query);
      const [documents, count] = await Promise.all([
        feedback
          .find(filter, { projection: { sessionId: 0 }, sort: { createdAt: -1 }, limit, skip })
          .toArray(),
        feedback.countDocuments(filter),
      ]);
      return { feedback: documents.map(toFeedbackProjection), total: count, page };
    },

    async getFeedback(id) {
      const document = await feedback.findOne({ _id: id }, { projection: { sessionId: 0 } });
      if (!document) throw new ApiError(404, 'NOT_FOUND', 'That feedback does not exist.');
      return { feedback: toFeedbackProjection(document) };
    },

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
        after: { status: set.status ?? existing.status ?? null, notesChanged: 'adminNotes' in set },
        correlationId: options.correlationId ?? null,
      });

      return { feedback: toFeedbackProjection(updated) };
    },

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

    async exportFeedbackCsv(admin, query = {}, options = {}) {
      const filter = feedbackFilter(query);
      const documents = await feedback
        .find(filter, { projection: { sessionId: 0 }, sort: { createdAt: -1 }, limit: MAX_EXPORT_ROWS })
        .toArray();

      const csv = toCsv([[...FEEDBACK_EXPORT_COLUMNS], ...documents.map(toExportRow)]);

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
