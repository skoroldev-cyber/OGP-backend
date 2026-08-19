/**
 * Founding Reader observations — Questionnaire v2.0 — and free-form reader feedback.
 *
 * The instrument is reached only through "Continue to Observations" at S13, after the
 * Opening Arc is complete. That ordering is a research requirement, not a UI preference:
 * "Please read the Opening Arc without stopping to edit", so no feedback surface may exist
 * mid-read and the server refuses to hand one out early.
 *
 * `reading_format` is recorded as `'immersive room'` for anyone who answers from inside the
 * reading room — that is the instrument's own vocabulary (§5.8), one of exactly four
 * values, and it is what tells a later analysis which surface produced a response. A reader
 * who read the DOCX and is answering here may say so; the default is the truthful one.
 *
 * For a Founding Reader the response carries `invitationId`, and the invitation advances to
 * `questionnaire_completed` — the last step of the Mode A pipeline. That link is the *only*
 * join between the response and the invitee's PII, and it exists for completion tracking.
 * Responses are research data, purpose-limited: never marketing, never per-reader targeting,
 * and quoting any of it anywhere requires the explicit permission answer plus anonymisation.
 *
 * **Free-form feedback** (`POST /feedback`) is the other half of this module and follows the
 * same ordering law. Nothing here renders during reading: while reading, a reader may only
 * *mark* a passage, and a mark is `{ unitId, charStart, charEnd, excerpt }` held locally
 * (§3.13, §14.4.1 — no popups, no forced overlays). Those marks arrive with the submission
 * afterwards, which is why this service anchors passages rather than collecting them.
 *
 * The feedback record carries no age band, no birthdate, no gender and no location. §9.2
 * keeps the band session-only and §14.4.3 forbids the profiling; the band is not withheld
 * here by a filter that could be forgotten, it simply has no field to occupy.
 */

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

/** The answer text the instrument's Yes/No permission question uses for consent. */
const CONSENT_YES = 'yes';

/**
 * Trim a string, or return null when there is nothing left worth storing.
 *
 * @param {unknown} value Any candidate value.
 * @param {number} [max] Length ceiling.
 * @returns {string|null} The trimmed text, or null.
 */
function trimmed(value, max = ANSWER_TEXT_MAX_LENGTH) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text.slice(0, max);
}

/**
 * Normalise one submitted answer against the question the instrument actually declares.
 *
 * The client is not trusted to send the right shape for a kind: a rating on an open-text
 * question, or a word chip the instrument never offered, is dropped rather than stored. What
 * is *not* dropped is a reviewer's prose — free text is accepted for every kind, because a
 * reviewer who writes a paragraph into an unexpected field has still told us something, and
 * discarding it to enforce a shape would be discarding the research.
 *
 * @param {object} question The declared question.
 * @param {object} submitted The submitted answer.
 * @returns {{ questionId: string, text: string|null, rating: number|null, values: string[] }|null}
 *          The stored answer, or null when the reviewer left it blank.
 */
function normaliseAnswer(question, submitted) {
  const text = trimmed(submitted.text);

  const rating =
    RATED_QUESTION_KINDS.includes(question.kind) &&
    Number.isInteger(submitted.rating) &&
    submitted.rating >= RATING_MIN &&
    submitted.rating <= RATING_MAX
      ? submitted.rating
      : null;

  // A choice is only a choice among the options the instrument offered. `single_choice`
  // keeps at most one, whatever arrived, so a client cannot turn a radio into a checkbox.
  const declared = Array.isArray(question.options) ? question.options : [];
  const submittedValues = Array.isArray(submitted.values) ? submitted.values : [];
  let values = declared.length > 0
    ? submittedValues.filter((value) => declared.includes(value))
    : [];
  if (question.kind === 'single_choice') values = values.slice(0, 1);
  values = [...new Set(values)].slice(0, ANSWER_MAX_VALUES);

  // A short line the instrument asks for as free text — a reviewer code, a date, an
  // approximate reading time — arrives as text and stays as text.
  if (text === null && rating === null && values.length === 0) return null;

  return { questionId: question.questionId, text, rating, values };
}

/**
 * Lift the answers the platform needs as fields of their own.
 *
 * Driven by each question's declared `role` rather than by its identifier, so renumbering
 * the reviewer metadata block in a later instrument does not silently detach the permission
 * to quote from the answer that granted it.
 *
 * @param {Map<string, object>} declared Questions by identifier.
 * @param {Array<object>} answers The normalised answers.
 * @returns {{ reviewer: object, readingFormat: string|null }} The lifted fields.
 */
function liftMetadata(declared, answers) {
  /** @type {Record<string, {text: string|null, values: string[]}>} */
  const byRole = {};
  for (const answer of answers) {
    const role = declared.get(answer.questionId)?.role;
    if (typeof role === 'string') byRole[role] = answer;
  }

  // A single-choice answer is carried in `values`; a typed line is carried in `text`.
  const chosen = (role) => byRole[role]?.values?.[0] ?? byRole[role]?.text ?? null;

  const consent = chosen('quote_consent');
  const format = chosen('reading_format');

  return {
    reviewer: {
      name: trimmed(chosen('reviewer_name'), 200),
      completedOn: trimmed(chosen('reviewer_date'), 32),
      readingTime: trimmed(chosen('reading_time'), 120),
      // Absent until the reviewer answers. `false` means they declined; `null` means they
      // were not asked or did not say, and the two must never collapse into each other.
      quoteConsent: typeof consent === 'string' ? consent.trim().toLowerCase() === CONSENT_YES : null,
    },
    readingFormat: READING_FORMATS.includes(format) ? format : null,
  };
}

/**
 * The reader's own view of one feedback record. Triage state is absent by construction.
 *
 * @param {object} document A `feedback` document.
 * @returns {object} The reader-facing projection.
 */
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

/**
 * @param {{ db: import('mongodb').Db, logger?: object, content?: object }} deps Dependencies.
 * @returns {object} The feedback service.
 */
export function createFeedbackService({ db, logger = null, content = null }) {
  const questionnaires = db.collection(COLLECTIONS.QUESTIONNAIRES);
  const responses = db.collection(COLLECTIONS.QUESTIONNAIRE_RESPONSES);
  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  const feedback = db.collection(COLLECTIONS.FEEDBACK);
  const repository = content ?? createContentRepository({ db, logger });

  /**
   * Resolve the marks a reader carried out of the reading room into stored anchors.
   *
   * A mark naming a unit the governing release does not contain is **dropped, quietly**.
   * The reading path degrades quietly (§3.12): a reader whose client held a mark from an
   * earlier release must not lose the paragraphs they wrote because of it, and must not be
   * shown a technical error about content identifiers either.
   *
   * @param {Array<object>|undefined} marks The submitted marks.
   * @returns {Promise<Array<object>>} Stored passage anchors, in submission order.
   */
  async function anchorPassages(marks) {
    if (!Array.isArray(marks) || marks.length === 0) return [];

    const anchors = [];
    for (const mark of marks.slice(0, FEEDBACK_MAX_PASSAGES)) {
      const facts = await repository.getUnitFacts(mark.unitId);
      if (!facts) continue;

      // Offsets are the reader's selection, not a claim about the text: an inverted or
      // partial range is normalised rather than rejected, because it still identifies the
      // passage well enough for a human reviewer to find it.
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

  /**
   * The instrument this session should answer: the one its cohort names, otherwise the
   * newest active one.
   *
   * @param {object} session The session document.
   * @returns {Promise<object|null>} The questionnaire document, or null.
   */
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
    /**
     * `GET /questionnaires/active`.
     *
     * **Not gated on arc completion.** It used to be, on the reasoning that the instrument
     * says "Please read the Opening Arc without stopping to edit" and therefore no feedback
     * surface may exist mid-read. That reasoning still holds for the reading room, where the
     * instrument is reached from "Continue to Observations" and from nowhere else — the
     * ordering is enforced there, by what is mounted at S13.
     *
     * It cannot hold here, because the instrument itself records `reading_format` as one of
     * DOCX, PDF, print or immersive room. A reviewer who was sent the manuscript as a
     * document read it, closed it, and came to answer: they completed the Opening Arc, and
     * the server has no record of it because there was nothing to record. Refusing them the
     * instrument would refuse three of the four formats the instrument asks about.
     *
     * @param {object} session The authenticated session document.
     * @returns {Promise<{ questionnaire: object|null }>} The instrument, or null.
     */
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

    /**
     * `POST /questionnaire-responses`.
     *
     * @param {object} session The authenticated session document.
     * @param {object} input The validated request body.
     * @returns {Promise<{ received: true }>} Confirmation.
     */
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

      // Answers to questions the instrument does not declare are dropped rather than
      // rejected: an out-of-date client must not cost a reader the answers they wrote.
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
        // The Founding Reader join, and the only one. Anonymous post-arc feedback carries
        // null here and is never attributable to a person.
        invitationId: typeof session.invitationId === 'string' ? session.invitationId : null,
        // Severable: `DELETE /sessions/current` nulls it.
        sessionId: session._id,
        cohortId: typeof session.cohortId === 'string' ? session.cohortId : null,
        answers,
        reviewer,
        // What the reviewer said outranks what the surface guessed, and the surface's guess
        // outranks the default.
        readingFormat:
          readingFormat ??
          (READING_FORMATS.includes(input.readingFormat)
            ? input.readingFormat
            : IMMERSIVE_READING_FORMAT),
        completedAt: now,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await responses.insertOne(document);
      } catch (error) {
        // The unique partial index on (questionnaireId, invitationId) means one set of
        // observations per Founding Reader. A second submission is a conflict, handled by
        // the error plugin's duplicate-key mapping.
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
            // The response is stored; completion tracking is secondary and must never undo
            // a reader's submitted work.
            logger?.error?.(
              { err: error, invitationId: document.invitationId },
              'invitation status could not be advanced after observations were received',
            );
          });
      }

      return { received: true };
    },

    /**
     * `POST /feedback` — free-form reader feedback.
     *
     * Three rules are enforced here rather than trusted to a client:
     *
     *  1. **The body is required; identity is not.** A reader may write anonymously. Name
     *     and email are offered, never demanded, and neither gates the submission.
     *  2. **An email is stored only with `contactConsent`.** Without it the address is
     *     discarded before the document is built — it is not written and then filtered, so
     *     there is no window in which it existed.
     *  3. **No age, anywhere.** The band is session state (§9.2) and has no field here.
     *
     * @param {object} session The authenticated session document.
     * @param {object} input The validated request body.
     * @returns {Promise<{ received: true, feedback: object }>} Quiet confirmation.
     */
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
        // Severable: `DELETE /sessions/current` nulls this and the feedback remains as
        // anonymous research material.
        sessionId: session._id,
        kind: passages.length > 0 ? 'passage' : 'general',
        category: FEEDBACK_CATEGORIES.includes(input.category)
          ? input.category
          : DEFAULT_FEEDBACK_CATEGORY,
        body,
        displayName,
        // The address exists on the document only when the reader asked to be reached.
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

    /**
     * `GET /feedback/mine` — what this session has sent, so a reader can see they were
     * heard. Read-only: there is no edit route and no delete route for a single record,
     * because feedback is research material once received. Erasing the session severs it.
     *
     * @param {object} session The authenticated session document.
     * @returns {Promise<{ feedback: object[] }>} The reader's own submissions, newest first.
     */
    async listOwnFeedback(session) {
      const documents = await feedback
        .find({ sessionId: session._id }, { sort: { createdAt: -1 }, limit: 100 })
        .toArray();
      return { feedback: documents.map(toOwnFeedback) };
    },
  };
}

export default createFeedbackService;
