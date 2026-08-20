export const STATES = Object.freeze({
  S0_SITE_ARRIVAL: 'S0',
  S1_DARKNESS: 'S1',
  S2_DISTANT_SPECK: 'S2',
  S3_LOGO_MANIFESTATION: 'S3',
  S4_LIVING_WEAVE: 'S4',
  S5_PORTAL_ENTRY: 'S5',
  S6_WEAVE_PASSAGE: 'S6',
  S7_EARTH_REVEAL: 'S7',
  S8_READING_ROOM_INVITATION: 'S8',
  S9_READING_ROOM_INIT: 'S9',
  S10_OPENING_ARC_READING: 'S10',
  S11_SHARE_OPPORTUNITY: 'S11',
  S12_CONTINUE_READING: 'S12',
  S13_OPENING_ARC_COMPLETE: 'S13',
  S14_CHOOSE_YOUR_PATH: 'S14',
});

export const STATE_CODES = Object.freeze(Object.values(STATES));

export const IMMERSION_STATES = Object.freeze([
  'entry',
  'orientation',
  'reading',
  'recognition',
  'reflection',
  'decompression',
  'sharing_ready',
  'return',
  'convergence',
  'become_family_threshold',
]);

export const PACE_MODES = Object.freeze(['slow', 'natural', 'deep', 'paused', 'returning']);

export const AGE_BANDS = Object.freeze(['8-12', '13-16', '17-19', '20-25', '26-32', '33+']);

export const CONTENT_LAYERS = Object.freeze([
  'foundation',
  'awakening',
  'transition',
  'emerging_adult',
  'grounded_adult',
  'full_manuscript',
]);

export const AGE_BAND_TO_LAYER = Object.freeze({
  '8-12': 'foundation',
  '13-16': 'awakening',
  '17-19': 'transition',
  '20-25': 'emerging_adult',
  '26-32': 'grounded_adult',
  '33+': 'full_manuscript',
});

export function layerForAgeBand(band) {
  if (typeof band !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(AGE_BAND_TO_LAYER, band)
    ? AGE_BAND_TO_LAYER[band]
    : null;
}

export const EVENT_NAMES = Object.freeze([
  'LandingStarted',
  'LogoManifestationStarted',
  'PortalEntryStarted',
  'EarthRevealCompleted',
  'ReadingRoomEntered',
  'ReadingSessionStarted',
  'ChapterCompleted',
  'SharePromptDisplayed',
  'ShareCompleted',
  'OpeningArcCompleted',
  'PathwaySelected',
  'ShareTokenOpened',
]);

export const EVENT_PAYLOAD_FIELDS = Object.freeze({
  LandingStarted: Object.freeze([
    'entryPath',
    'referrerDomain',
    'reducedMotion',
    'deviceTier',
    'locale',
    'isReturnVisit',
  ]),
  LogoManifestationStarted: Object.freeze(['msSinceLanding', 'skippedIntro']),
  PortalEntryStarted: Object.freeze([
    'msSinceLanding',
    'inputMethod',
    'skippedCinematic',
    'silentMode',
    'motionMode',
  ]),
  EarthRevealCompleted: Object.freeze(['msSinceLanding', 'mode', 'audioEnabled']),
  ReadingRoomEntered: Object.freeze(['msSinceLanding', 'entryType']),
  ReadingSessionStarted: Object.freeze(['resume', 'lastUnitId']),
  ChapterCompleted: Object.freeze(['unitId', 'componentIndex', 'msReading']),
  SharePromptDisplayed: Object.freeze(['promptId', 'unitId', 'windowType', 'visualTreatment']),
  ShareCompleted: Object.freeze(['promptId', 'shareTokenId', 'channel']),
  ShareTokenOpened: Object.freeze(['shareTokenId']),
  OpeningArcCompleted: Object.freeze([
    'totalMsReading',
    'componentsCompleted',
    'sharesCompleted',
  ]),
  PathwaySelected: Object.freeze(['pathway']),
});

export const EVENT_PAYLOAD_COMMON_FIELDS = Object.freeze(['skipped']);

export function allowedPayloadFields(name) {
  const named = EVENT_PAYLOAD_FIELDS[name];
  if (!named) return [];
  return [...named, ...EVENT_PAYLOAD_COMMON_FIELDS];
}

export const EVENT_BATCH_LIMIT = 20;

export const PATHWAYS = Object.freeze([
  'continue_founders_edition',
  'donate_digital_transcript',
  'purchase_hardcover',
  'become_family',
  'support_mission',
  'share_opening_arc',
  'return_later',
]);

export const UNIT_TYPES = Object.freeze([
  'opening_arc',
  'chapter',
  'section',
  'passage',
  'quote',
  'transition',
  'reflection',
  'decompression',
  'threshold',
  'front_matter',
]);

export const CONTENT_ROLES = Object.freeze([
  'orientation',
  'exposure',
  'recognition',
  'decompression',
  'convergence',
  'transition',
  'invitation',
]);

export const EMOTIONAL_TONES = Object.freeze([
  'calm',
  'grave',
  'reflective',
  'intense',
  'tender',
  'clarifying',
  'convergent',
]);

export const EDITORIAL_STATUSES = Object.freeze([
  'draft',
  'review',
  'approved',
  'published',
  'archived',
]);

export const NODE_TYPES = Object.freeze([
  'recognition_peak',
  'decompression_window',
  'human_reconnection',
  'return_window',
  'convergence_threshold',
  'no_share_zone',
]);

export const WINDOW_TYPES = Object.freeze([
  'quiet_recognition',
  'decompression',
  'human_reconnection',
  'return',
  'convergence',
]);

export const VISUAL_TREATMENTS = Object.freeze([
  'minimal',
  'quiet_inline',
  'isolated',
  'full_breath',
]);

export const PROMPT_TYPES = Object.freeze([
  'silent',
  'soft',
  'reflective',
  'continuity',
  'threshold',
]);

export const PROMPT_FREQUENCIES = Object.freeze(['rare']);

export const SHARING_WINDOW_NODE_TYPES = Object.freeze([
  'decompression_window',
  'human_reconnection',
  'return_window',
  'convergence_threshold',
]);

export const SHARING_READY_IMMERSION_STATES = Object.freeze([
  'sharing_ready',
  'return',
  'convergence',
]);

export const FEEDBACK_CATEGORIES = Object.freeze([
  'clarity',
  'honesty',
  'accessibility',
  'pacing',
  'emotional_weight',
  'factual_concern',
  'technical_problem',
  'other',
]);

export const DEFAULT_FEEDBACK_CATEGORY = 'other';

export const FEEDBACK_KINDS = Object.freeze(['general', 'passage']);

export const FEEDBACK_STATUSES = Object.freeze(['new', 'triaged', 'actioned', 'archived']);

export const DEFAULT_FEEDBACK_STATUS = 'new';

export const FEEDBACK_BODY_MAX_LENGTH = 4000;
export const FEEDBACK_EXCERPT_MAX_LENGTH = 500;
export const FEEDBACK_MAX_PASSAGES = 20;

export const QUESTION_KINDS = Object.freeze([
  'scale',
  'single_choice',
  'multi_choice',
  'open_text',
  'rated_text',
  'chips_text',
  'short_text',
  'date',
]);

export const RATED_QUESTION_KINDS = Object.freeze(['scale', 'rated_text']);

export const QUESTION_ROLES = Object.freeze([
  'reviewer_name',
  'reviewer_date',
  'reading_format',
  'reading_time',
  'quote_consent',
]);

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export const READING_FORMATS = Object.freeze(['DOCX', 'PDF', 'print', 'immersive room']);

export const IMMERSIVE_READING_FORMAT = 'immersive room';

export const ANSWER_TEXT_MAX_LENGTH = 4000;
export const ANSWER_MAX_VALUES = 40;
export const QUESTIONNAIRE_MAX_QUESTIONS = 200;

export const INVITATION_STATUSES = Object.freeze([
  'new_interest',
  'approved',
  'invited',
  'welcome_sent',
  'reading_link_sent',
  'opened',
  'redeemed',
  'questionnaire_completed',
  'follow_up_needed',
  'not_selected',
  'revoked',
]);

export const EMAIL_TEMPLATE_KEYS = Object.freeze(['beta_invitation', 'beta_welcome']);

export const ADMIN_ROLES = Object.freeze([
  'founder',
  'architect',
  'editor',
  'reviewer',
  'beta_coordinator',
  'finance',
]);

export const RESERVED_WORLD_MONITOR_ROLES = Object.freeze([
  'source_curator',
  'researcher',
  'verifier',
  'publisher',
  'methodology_admin',
]);

export const AUDIT_ACTOR_TYPES = Object.freeze(['admin', 'system', 'webhook']);

export const PROHIBITED_FIELDS = Object.freeze([
  'birthdate',
  'dateOfBirth',
  'gender',
  'sex',
  'ip',
  'ipAddress',
  'userAgent',
  'politicalAffiliation',
  'religion',
  'ethnicity',
  'race',
  'location',
  'geo',
  'latitude',
  'longitude',
  'fingerprint',
  'deviceId',
]);

export const ENTRY_VIA = Object.freeze(['direct', 'share_token', 'invitation']);

export const MOTION_PREFERENCES = Object.freeze(['full', 'reduced', 'off']);

export const SCHEMA_VERSION = 1;
