import {
  ANSWER_MAX_VALUES,
  ANSWER_TEXT_MAX_LENGTH,
  DEFAULT_FEEDBACK_CATEGORY,
  DEFAULT_FEEDBACK_STATUS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_PASSAGES,
  IMMERSIVE_READING_FORMAT,
  RATED_QUESTION_KINDS,
  RATING_MAX,
  RATING_MIN,
  READING_FORMATS,
  SCHEMA_VERSION,
} from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { newId } from '../../lib/ids.js';
import { ApiError } from '../../plugins/errors.js';
import { createContentRepository } from '../manuscript/service.js';

const CONSENT_YES = 'yes';

function trimmed(value, max = ANSWER_TEXT_MAX_LENGTH) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text.slice(0, max);
}

function normaliseAnswer(question, submitted) {
  const text = trimmed(submitted.text);

  const rating =
    RATED_QUESTION_KINDS.includes(question.kind) &&
    Number.isInteger(submitted.rating) &&
    submitted.rating >= RATING_MIN &&
    submitted.rating <= RATING_MAX
      ? submitted.rating
      : null;

  const declared = Array.isArray(question.options) ? question.options : [];
  const submittedValues = Array.isArray(submitted.values) ? submitted.values : [];
  let values = declared.length > 0
    ? submittedValues.filter((value) => declared.includes(value))
    : [];
  if (question.kind === 'single_choice') values = values.slice(0, 1);
  values = [...new Set(values)].slice(0, ANSWER_MAX_VALUES);

  if (text === null && rating === null && values.length === 0) return null;

  return { questionId: question.questionId, text, rating, values };
}

function liftMetadata(declared, answers) {
  const byRole = {};
  for (const answer of answers) {
    const role = declared.get(answer.questionId)?.role;
    if (typeof role === 'string') byRole[role] = answer;
  }

  const chosen = (role) => byRole[role]?.values?.[0] ?? byRole[role]?.text ?? null;

  const consent = chosen('quote_consent');
  const format = chosen('reading_format');

  return {
    reviewer: {
      name: trimmed(chosen('reviewer_name'), 200),
      completedOn: trimmed(chosen('reviewer_date'), 32),
      readingTime: trimmed(chosen('reading_time'), 120),
      quoteConsent: typeof consent === 'string' ? consent.trim().toLowerCase() === CONSENT_YES : null,
    },
    readingFormat: READING_FORMATS.includes(format) ? format : null,
  };
}

export function toOwnFeedback(document) {
  return {
    id: document._id,
    kind: document.kind,
    category: document.category,
    body: document.body,
    passages: (Array.isArray(document.passages) ? document.passages : []).map((passage) => ({
      unitId: passage.unitId,
      componentIndex: Number.isInteger(passage.componentIndex) ? passage.componentIndex : null,
      excerpt: passage.excerpt ?? null,
      charStart: Number.isInteger(passage.charStart) ? passage.charStart : null,
      charEnd: Number.isInteger(passage.charEnd) ? passage.charEnd : null,
    })),
    contactConsent: document.contactConsent === true,
    createdAt: document.createdAt instanceof Date ? document.createdAt.toISOString() : null,
  };
}

export function createFeedbackService({ db, logger = null, content = null }) {
  const questionnaires = db.collection(COLLECTIONS.QUESTIONNAIRES);
  const responses = db.collection(COLLECTIONS.QUESTIONNAIRE_RESPONSES);
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const feedback = db.collection(COLLECTIONS.FEEDBACK);
  const repository = content ?? createContentRepository({ db, logger });

  async function anchorPassages(marks) {
    if (!Array.isArray(marks) || marks.length === 0) return [];

    const anchors = [];
    for (const mark of marks.slice(0, FEEDBACK_MAX_PASSAGES)) {
      const facts = await repository.getUnitFacts(mark.unitId);
      if (!facts) continue;

      const start = Number.isInteger(mark.charStart) ? mark.charStart : null;
      const end = Number.isInteger(mark.charEnd) ? mark.charEnd : null;
      const ordered = start !== null && end !== null && end < start ? [end, start] : [start, end];

      anchors.push({
        unitId: facts.unitId,
        componentIndex: Number.isInteger(facts.componentIndex) ? facts.componentIndex : null,
        excerpt: typeof mark.excerpt === 'string' && mark.excerpt !== '' ? mark.excerpt : null,
        charStart: ordered[0],
        charEnd: ordered[1],
      });
    }
    return anchors;
  }

  async function resolveActive(session) {
    if (typeof session.cohortId === 'string') {
      const cohort = await db
        .collection(COLLECTIONS.COHORTS)
        .findOne({ _id: session.cohortId }, { projection: { questionnaireId: 1 } });
      if (typeof cohort?.questionnaireId === 'string') {
        const named = await questionnaires.findOne({
          _id: cohort.questionnaireId,
          status: 'active',
        });
        if (named) return named;
      }
    }
    return questionnaires.findOne({ status: 'active' }, { sort: { version: -1 } });
  }

  return {
    async activeQuestionnaire(session) {
      const document = await resolveActive(session);
      if (!document) return { questionnaire: null };

      const questions = Array.isArray(document.questions) ? [...document.questions] : [];
      questions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      return {
        questionnaire: {
          questionnaireId: document._id,
          title: document.title,
          version: document.version,
          purpose: document.purpose ?? null,
          instruction: document.instruction ?? null,
          scaleLegend: document.scaleLegend ?? null,
          sections: (Array.isArray(document.sections) ? document.sections : []).map(
            (section) => ({
              key: section.key,
              title: section.title,
              description: section.description ?? null,
            }),
          ),
          questions: questions.map((question) => ({
            questionId: question.questionId,
            order: question.order ?? 0,
            kind: question.kind,
            prompt: question.prompt,
            label: question.label ?? null,
            section: question.section ?? null,
            scaleLegend: question.scaleLegend ?? null,
            role: question.role ?? null,
            options: Array.isArray(question.options) ? question.options : null,
            required: question.required === true,
          })),
        },
      };
    },

    async submitResponse(session, input) {
      const questionnaire = await questionnaires.findOne({
        _id: input.questionnaireId,
        status: 'active',
      });
      if (!questionnaire) {
        throw new ApiError(404, 'QUESTIONNAIRE_NOT_FOUND', 'That set of observations is not open.');
      }

      const declared = new Map(
        (Array.isArray(questionnaire.questions) ? questionnaire.questions : []).map((question) => [
          question.questionId,
          question,
        ]),
      );

      const answers = [];
      const answered = new Set();
      for (const entry of input.answers) {
        const question = declared.get(entry.questionId);
        if (!question || answered.has(entry.questionId)) continue;
        answered.add(entry.questionId);
        const normalised = normaliseAnswer(question, entry);
        if (normalised) answers.push(normalised);
      }

      const missing = [...declared.values()]
        .filter((question) => question.required === true && !answered.has(question.questionId))
        .map((question) => question.questionId);
      if (missing.length > 0) {
        throw new ApiError(422, 'RESPONSE_INCOMPLETE', 'Some answers are still needed.');
      }
      if (answers.length === 0) {
        throw new ApiError(422, 'RESPONSE_INCOMPLETE', 'Some answers are still needed.');
      }

      const now = new Date();
      const { reviewer, readingFormat } = liftMetadata(declared, answers);

      const document = {
        _id: newId(),
        questionnaireId: questionnaire._id,
        invitationId: typeof session.invitationId === 'string' ? session.invitationId : null,
        sessionId: session._id,
        cohortId: typeof session.cohortId === 'string' ? session.cohortId : null,
        answers,
        reviewer,
        // The reviewer's own answer, then whatever the submitting surface can vouch for, then
        // nothing. There is deliberately no default: only S13 witnessed a reading, and
        // recording an unanswered question as `immersive room` would put a fact in the study
        // record that nobody stated — and it would do it to precisely the reviewers who read
        // the manuscript as a document, which is the group the format question exists for.
        readingFormat:
          readingFormat ??
          (READING_FORMATS.includes(input.readingFormat) ? input.readingFormat : null),
        completedAt: now,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await responses.insertOne(document);
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(
            409,
            'OBSERVATIONS_ALREADY_RECEIVED',
            'Your observations have already been received.',
          );
        }
        throw error;
      }

      if (document.invitationId) {
        await invitations
          .updateOne(
            { _id: document.invitationId },
            { $set: { status: 'questionnaire_completed', ...updateStamps(now) } },
          )
          .catch((error) => {
            logger?.error?.(
              { err: error, invitationId: document.invitationId },
              'invitation status could not be advanced after observations were received',
            );
          });
      }

      return { received: true };
    },

    async submitFeedback(session, input = {}) {
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (body === '') {
        throw new ApiError(422, 'FEEDBACK_EMPTY', 'There is nothing written to send yet.');
      }

      const now = new Date();
      const passages = await anchorPassages(input.passages);
      const contactConsent = input.contactConsent === true;
      const displayName =
        typeof input.displayName === 'string' && input.displayName.trim() !== ''
          ? input.displayName.trim()
          : null;

      const document = {
        _id: newId(),
        sessionId: session._id,
        kind: passages.length > 0 ? 'passage' : 'general',
        category: FEEDBACK_CATEGORIES.includes(input.category)
          ? input.category
          : DEFAULT_FEEDBACK_CATEGORY,
        body,
        displayName,
        email: contactConsent && typeof input.email === 'string' ? input.email : null,
        contactConsent,
        passages,
        releaseId: await repository.getReleaseId().catch(() => null),
        readingFormat: IMMERSIVE_READING_FORMAT,
        invitationId: typeof session.invitationId === 'string' ? session.invitationId : null,
        cohortId: typeof session.cohortId === 'string' ? session.cohortId : null,
        status: DEFAULT_FEEDBACK_STATUS,
        adminNotes: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      await feedback.insertOne(document);

      return { received: true, feedback: toOwnFeedback(document) };
    },

    async listOwnFeedback(session) {
      const documents = await feedback
        .find({ sessionId: session._id }, { sort: { createdAt: -1 }, limit: 100 })
        .toArray();
      return { feedback: documents.map(toOwnFeedback) };
    },
  };
}

export default createFeedbackService;
