const SCALE_LEGEND =
  '1 = not at all, 2 = weak, 3 = moderate, 4 = strong, 5 = very strong.';

const READER_STATE_WORDS = Object.freeze([
  'despair',
  'clarity',
  'responsibility',
  'hope',
  'activation',
  'resistance',
  'confusion',
]);

const READING_FORMATS = Object.freeze(['DOCX', 'PDF', 'print', 'immersive room']);

const QUESTIONS = [
  {
    questionId: 'q01_opening_capture',
    label: 'Opening capture',
    kind: 'open_text',
    prompt:
      'At what point did the Opening Arc first pull you in emotionally or intellectually? If it did not, where did it fail to capture you?',
  },
  {
    questionId: 'q02_attention_continuity',
    label: 'Attention continuity',
    kind: 'open_text',
    prompt:
      'Where, if anywhere, did your attention weaken, drift, or break? Please name the section, page, or passage.',
  },
  {
    questionId: 'q03_emotional_movement',
    label: 'Emotional movement',
    kind: 'rated_text',
    prompt:
      'Did the sequence move you from exposure, to recognition, to responsibility, to the threshold? Rate 1–5 and explain briefly.',
  },
  {
    questionId: 'q04_recognition',
    label: 'Recognition',
    kind: 'rated_text',
    prompt:
      'Did the manuscript make you feel that harms in Gaza, Ukraine, Flint, Bhopal, America, China, and elsewhere were connected as family harms rather than distant events? Rate 1–5 and explain.',
  },
  {
    questionId: 'q05_witness_intensity',
    label: 'Witness intensity',
    kind: 'open_text',
    prompt:
      'Did the witness sections create recognition and responsibility, or did they become overwhelming or numbing? Explain which section affected you most.',
  },
  {
    questionId: 'q06_loneliness_relationship',
    label: 'Loneliness and relationship',
    kind: 'rated_text',
    prompt:
      'Did the loneliness section help connect global harm to your own life or community experience? Rate 1–5 and explain.',
  },
  {
    questionId: 'q07_american_chinese_mirror',
    label: 'American/Chinese mirror',
    kind: 'open_text',
    prompt:
      'Did the American fracture and Chinese erasure section feel connected to the theme of Relationship, or did it feel like a separate political section? Explain.',
  },
  {
    questionId: 'q08_identity_recovery',
    label: 'Identity recovery',
    kind: 'open_text',
    prompt:
      'Did the identity-recovery passage feel restorative, too dense, or necessary? What line stayed with you most?',
  },
  {
    questionId: 'q09_threshold_impact',
    label: 'Threshold impact',
    kind: 'rated_text',
    prompt:
      'Did Section 8 — The Threshold make you want to continue into Chapter 2 — Awareness? Rate 1–5 and explain.',
  },
  {
    questionId: 'q10_shareability',
    label: 'Shareability',
    kind: 'open_text',
    prompt:
      'Would you share this Opening Arc with someone else? If yes, who and why? If no, what would prevent you from sharing it?',
  },
  {
    questionId: 'q11_memorable_moment',
    label: 'Most memorable line or moment',
    kind: 'open_text',
    prompt: 'What sentence, image, or section stayed with you after reading?',
  },
  {
    questionId: 'q12_final_reader_state',
    label: 'Final reader state',
    kind: 'chips_text',
    options: READER_STATE_WORDS,
    prompt:
      'After finishing, did you feel despair, clarity, responsibility, hope, activation, resistance, confusion, or something else? Choose the closest words and explain.',
  },
  {
    questionId: 'q13_requested_change',
    label: 'One requested change',
    kind: 'open_text',
    prompt:
      'If you could change one thing before beta release or publication, what would it be?',
  },
  {
    questionId: 'q14_overall_readiness',
    label: 'Overall readiness',
    kind: 'rated_text',
    prompt:
      'Do you believe this Opening Arc is ready to be shown to a wider beta audience? Rate 1–5 and explain why.',
  },

  {
    questionId: 'm01_reviewer',
    section: 'reviewer',
    role: 'reviewer_name',
    label: 'Name or reviewer code',
    kind: 'short_text',
    prompt: 'Name or reviewer code',
  },
  {
    questionId: 'm02_date_completed',
    section: 'reviewer',
    role: 'reviewer_date',
    label: 'Date completed',
    kind: 'date',
    prompt: 'Date completed',
  },
  {
    questionId: 'm03_reading_format',
    section: 'reviewer',
    role: 'reading_format',
    label: 'Reading format used',
    kind: 'single_choice',
    options: READING_FORMATS,
    prompt: 'Reading format used (DOCX / PDF / print / immersive room)',
  },
  {
    questionId: 'm04_reading_time',
    section: 'reviewer',
    role: 'reading_time',
    label: 'Approximate reading time',
    kind: 'short_text',
    prompt: 'Approximate reading time',
  },
  {
    questionId: 'm05_quote_permission',
    section: 'reviewer',
    role: 'quote_consent',
    label: 'Permission to quote',
    kind: 'single_choice',
    options: ['Yes', 'No'],
    prompt: 'Permission to quote anonymous feedback?',
  },
];

export const QUESTIONNAIRE_V2 = {
  _id: 'q_v2_0',
  title: 'Opening Arc Beta Test Questionnaire',
  version: '2.0',
  status: 'active',
  schemaVersion: 1,

  purpose:
    'This questionnaire is designed to test the Opening Arc as a reader experience: emotional capture, attention continuity, recognition, shareability, and whether the threshold into the manuscript lands as intended.',
  instruction:
    'Please read the Opening Arc without stopping to edit. After reading, answer the questions below as honestly and specifically as possible. When something works, say where it worked. When your attention breaks, name the section or page where it happened.',
  scaleLegend: `For scaled questions, use 1 to 5: ${SCALE_LEGEND}`,

  sections: [
    { key: 'core', title: 'Core questions', description: null },
    {
      key: 'reviewer',
      title: 'Reviewer metadata',
      description: 'For the study record. Every field is optional.',
    },
  ],

  questions: QUESTIONS.map((question, index) => ({
    questionId: question.questionId,
    order: index + 1,
    kind: question.kind,
    prompt: question.prompt,
    label: question.label,
    options: question.options ? [...question.options] : null,
    required: false,
    section: question.section ?? 'core',
    role: question.role ?? null,
    scaleLegend: question.kind === 'rated_text' ? SCALE_LEGEND : null,
  })),
};

export default QUESTIONNAIRE_V2;
