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

const answer = objectSchema(
  {
    questionId: identifier,
    text: { type: ['string', 'null'], maxLength: ANSWER_TEXT_MAX_LENGTH },
    rating: { type: ['integer', 'null'], minimum: RATING_MIN, maximum: RATING_MAX },
    values: arraySchema(boundedString(280, 1), { maxItems: ANSWER_MAX_VALUES }),
  },
  { required: ['questionId'] },
);

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

const passageInput = objectSchema(
  {
    unitId: identifier,
    excerpt: boundedString(FEEDBACK_EXCERPT_MAX_LENGTH),
    charStart: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    charEnd: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
  { required: ['unitId'] },
);

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

export const createFeedbackResponse = objectSchema(
  { received: { type: 'boolean' }, feedback: ownFeedback },
  { required: ['received', 'feedback'] },
);

export const ownFeedbackResponse = objectSchema(
  { feedback: arraySchema(ownFeedback, { maxItems: 100 }) },
  { required: ['feedback'] },
);

export const ownFeedbackQuery = objectSchema({});

export const feedbackHeaders = sessionTokenHeader;
export const feedbackErrorResponses = errorResponses(400, 401, 404, 409, 422, 429, 500, 503);
