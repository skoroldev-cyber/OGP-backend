/**
 * Feedback schemas — the Questionnaire v2.0 instrument, and free-form reader feedback.
 *
 * Question content is data, not code: the instrument is stored in `questionnaires` and
 * rendered verbatim, so a wording change is an editorial act rather than a deployment.
 *
 * Free-text answers are research data and are purpose-limited. They are capped in length
 * here, never logged, never emitted into an event payload, and never joined to anything
 * except the response record itself.
 *
 * The free-form shapes below declare **no age field of any kind**, and there is nowhere for
 * one to hide: `additionalProperties: false` means a client that sends `ageBand`,
 * `birthdate` or `location` is refused at the schema rather than quietly ignored.
 */

import {
  ANSWER_MAX_VALUES,
  ANSWER_TEXT_MAX_LENGTH,
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_CATEGORIES,
  FEEDBACK_EXCERPT_MAX_LENGTH,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_PASSAGES,
  IMMERSIVE_READING_FORMAT,
  QUESTIONNAIRE_MAX_QUESTIONS,
  QUESTION_KINDS,
  QUESTION_ROLES,
  RATING_MAX,
  RATING_MIN,
  READING_FORMATS,
} from '../../config/constants.js';
import {
  arraySchema,
  boundedString,
  email,
  enumOf,
  errorResponses,
  identifier,
  nullableEnumOf,
  objectSchema,
  sessionTokenHeader,
} from '../../lib/schemas.js';

export { IMMERSIVE_READING_FORMAT, READING_FORMATS };

/**
 * One question as the instrument declares it.
 *
 * `label` and `section` are presentation facts the instrument owns, not the client: the
 * numbered headings ("3. Emotional movement") and the split between the core questions and
 * the reviewer metadata are part of the instrument's design, and a client that invented its
 * own grouping would be showing a different instrument than the one under test.
 */
const questionnaireQuestion = objectSchema(
  {
    questionId: identifier,
    order: { type: 'integer', minimum: 0, maximum: 500 },
    kind: enumOf(QUESTION_KINDS),
    prompt: boundedString(2000, 1),
    label: { type: ['string', 'null'], maxLength: 200 },
    section: { type: ['string', 'null'], maxLength: 64 },
    scaleLegend: { type: ['string', 'null'], maxLength: 500 },
    role: nullableEnumOf(QUESTION_ROLES),
    options: { type: ['array', 'null'], maxItems: 40, items: boundedString(200) },
    required: { type: 'boolean' },
  },
  { required: ['questionId', 'order', 'kind', 'prompt', 'required'] },
);

const questionnaireSection = objectSchema(
  {
    key: boundedString(64, 1),
    title: boundedString(200, 1),
    description: { type: ['string', 'null'], maxLength: 1000 },
  },
  { required: ['key', 'title'] },
);

/**
 * `null` when no instrument is active. The header blocks — purpose, instruction, the scale
 * legend — travel with the questions because they are part of the instrument being tested:
 * "Please read the Opening Arc without stopping to edit" is an instruction to the reviewer
 * that changes the answers, so it cannot be a string the client happens to hold.
 */
export const activeQuestionnaireResponse = objectSchema(
  {
    questionnaire: objectSchema(
      {
        questionnaireId: identifier,
        title: boundedString(200, 1),
        version: boundedString(16, 1),
        purpose: { type: ['string', 'null'], maxLength: 2000 },
        instruction: { type: ['string', 'null'], maxLength: 2000 },
        scaleLegend: { type: ['string', 'null'], maxLength: 500 },
        sections: arraySchema(questionnaireSection, { maxItems: 20 }),
        questions: arraySchema(questionnaireQuestion, {
          maxItems: QUESTIONNAIRE_MAX_QUESTIONS,
        }),
      },
      { required: ['questionnaireId', 'title', 'version', 'questions'], nullable: true },
    ),
  },
  { required: ['questionnaire'] },
);

/**
 * One answer, in three flat parts rather than one polymorphic value.
 *
 * The instrument asks compound questions — "Rate 1–5 and explain", "Choose the closest words
 * and explain" — so a single answer routinely carries a rating *and* a paragraph, or a word
 * set *and* a paragraph. Splitting them here is what lets the founder ask "what did Q9
 * average" without every consumer having to know which questions store a number inside a
 * string. Every part is optional; a question the reviewer skipped simply sends nothing.
 */
const answer = objectSchema(
  {
    questionId: identifier,
    text: { type: ['string', 'null'], maxLength: ANSWER_TEXT_MAX_LENGTH },
    rating: { type: ['integer', 'null'], minimum: RATING_MIN, maximum: RATING_MAX },
    values: arraySchema(boundedString(280, 1), { maxItems: ANSWER_MAX_VALUES }),
  },
  { required: ['questionId'] },
);

/**
 * A submission is the instrument's questions and nothing else.
 *
 * There is deliberately no `reviewer` block here, and no consent flag. The instrument asks
 * for a reviewer code, a date, a reading format, a reading time and permission to quote — so
 * those arrive as answers like every other answer, and the server lifts them onto their own
 * fields using the `role` each question declares. A client that could send `quoteConsent`
 * independently of the question that asks for it would be a client that could grant a
 * permission the reviewer never gave.
 *
 * `readingFormat` remains accepted as a fallback only: it records the surface a submission
 * came from when the reviewer left that question blank.
 */
export const submitResponseBody = objectSchema(
  {
    questionnaireId: identifier,
    answers: arraySchema(answer, { maxItems: QUESTIONNAIRE_MAX_QUESTIONS, minItems: 1 }),
    readingFormat: enumOf(READING_FORMATS),
  },
  { required: ['questionnaireId', 'answers'] },
);

export const submitResponseResponse = objectSchema(
  { received: { type: 'boolean' } },
  { required: ['received'] },
);

/* -------------------------------------------------------------------------- */
/* Free-form feedback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One marked passage, as the reader's local marks describe it: `{ unitId, charStart,
 * charEnd, excerpt }` (§3.13). `componentIndex` is absent from the input on purpose — the
 * server resolves it from the unit, so a client cannot file a comment against a component
 * the passage does not belong to.
 */
const passageInput = objectSchema(
  {
    unitId: identifier,
    excerpt: boundedString(FEEDBACK_EXCERPT_MAX_LENGTH),
    charStart: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    charEnd: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
  { required: ['unitId'] },
);

/**
 * `POST /feedback`.
 *
 * `body` is the only required field. Name and email are optional because feedback is not a
 * transaction and a reader owes the platform no identity; `contactConsent` defaults to
 * false, and an address arriving without it is discarded rather than stored.
 *
 * `kind` is not accepted: it is derived from whether any passages arrived.
 */
export const createFeedbackBody = objectSchema(
  {
    category: enumOf(FEEDBACK_CATEGORIES),
    body: boundedString(FEEDBACK_BODY_MAX_LENGTH, 1),
    displayName: boundedString(160),
    email,
    contactConsent: { type: 'boolean' },
    passages: arraySchema(passageInput, { maxItems: FEEDBACK_MAX_PASSAGES }),
  },
  { required: ['body'] },
);

/** A passage as it is echoed back to the reader who marked it. */
const passageProjection = objectSchema(
  {
    unitId: identifier,
    componentIndex: { type: ['integer', 'null'] },
    excerpt: { type: ['string', 'null'], maxLength: FEEDBACK_EXCERPT_MAX_LENGTH },
    charStart: { type: ['integer', 'null'] },
    charEnd: { type: ['integer', 'null'] },
  },
  { required: ['unitId'] },
);

/**
 * What a reader may see of their own feedback.
 *
 * Deliberately not present: `status`. Triage state is staff workflow, and telling someone
 * their words were "archived" is not information they asked for.
 */
const ownFeedback = objectSchema(
  {
    id: { type: 'string', maxLength: 64 },
    kind: enumOf(FEEDBACK_KINDS),
    category: enumOf(FEEDBACK_CATEGORIES),
    body: boundedString(FEEDBACK_BODY_MAX_LENGTH, 1),
    passages: arraySchema(passageProjection, { maxItems: FEEDBACK_MAX_PASSAGES }),
    contactConsent: { type: 'boolean' },
    createdAt: { type: ['string', 'null'], format: 'date-time' },
  },
  { required: ['id', 'kind', 'category', 'body', 'passages', 'contactConsent'] },
);

/** One quiet confirmation. Nothing to act on, nothing to decide. */
export const createFeedbackResponse = objectSchema(
  { received: { type: 'boolean' }, feedback: ownFeedback },
  { required: ['received', 'feedback'] },
);

export const ownFeedbackResponse = objectSchema(
  { feedback: arraySchema(ownFeedback, { maxItems: 100 }) },
  { required: ['feedback'] },
);

/**
 * `GET /feedback/mine` takes no filters — a reader's own list is short and complete — but
 * still declares a closed query object, so a stray parameter is refused rather than ignored.
 */
export const ownFeedbackQuery = objectSchema({});

export const feedbackHeaders = sessionTokenHeader;
export const feedbackErrorResponses = errorResponses(400, 401, 404, 409, 422, 429, 500, 503);
