/**
 * Canonical vocabularies for the One Global People platform.
 *
 * Every enum in this file is a contract, not a convenience. The frontend state machine,
 * the MongoDB validators, the event ingest whitelist and the admin dashboard all read
 * from here. Nothing in this file may be widened without a corresponding change in
 * BUILD_CONTRACT.md and ONE_GLOBAL_PEOPLE_MASTER_IMPLEMENTATION.md.
 */

/* -------------------------------------------------------------------------- */
/* State machine                                                               */
/* -------------------------------------------------------------------------- */

/**
 * S0–S14, mirroring `frontend/src/experience/states.js` exactly.
 * `reading_sessions.currentState` stores the value side ('S0'…'S14').
 */
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

/** The bare state codes, in canonical order. */
export const STATE_CODES = Object.freeze(Object.values(STATES));

/** Immersion sub-machine, active inside S9–S14. */
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

/** Reading pace modes. */
export const PACE_MODES = Object.freeze(['slow', 'natural', 'deep', 'paused', 'returning']);

/* -------------------------------------------------------------------------- */
/* Age layer                                                                   */
/* -------------------------------------------------------------------------- */

/** Age bands. Session state only — never profiled, never persisted elsewhere. */
export const AGE_BANDS = Object.freeze(['8-12', '13-16', '17-19', '20-25', '26-32', '33+']);

/** Content layers. `full_manuscript` is the only certified layer today. */
export const CONTENT_LAYERS = Object.freeze([
  'foundation',
  'awakening',
  'transition',
  'emerging_adult',
  'grounded_adult',
  'full_manuscript',
]);

/**
 * The founder's routing map, verbatim. This is the only place the mapping exists.
 * Changing a single arrow here changes what a reader is shown.
 */
export const AGE_BAND_TO_LAYER = Object.freeze({
  '8-12': 'foundation',
  '13-16': 'awakening',
  '17-19': 'transition',
  '20-25': 'emerging_adult',
  '26-32': 'grounded_adult',
  '33+': 'full_manuscript',
});

/**
 * Pure routing function. No history is kept: switching depth overwrites the band.
 *
 * @param {string|null|undefined} band One of AGE_BANDS.
 * @returns {string|null} The content layer, or null when no band is declared.
 */
export function layerForAgeBand(band) {
  if (typeof band !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(AGE_BAND_TO_LAYER, band)
    ? AGE_BAND_TO_LAYER[band]
    : null;
}

/* -------------------------------------------------------------------------- */
/* Event catalog                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The eleven canonical events plus the proposed twelfth (receiver-side share arrival).
 * The superseded 061226 taxonomy (`threshold_viewed`, …) must never run alongside this.
 */
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

/**
 * Per-event payload whitelist (BUILD_CONTRACT §3). Unknown keys are dropped item-wise;
 * an unknown key never fails the batch.
 *
 * Never permitted in any payload: ageRange, IP, user-agent string, geolocation,
 * a full referrer URL (domain only), or any free text authored by the reader.
 */
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

/**
 * Fields permitted on every event regardless of name.
 *
 * `skipped` reconciles BUILD_CONTRACT §2 (skip "back-emits any bypassed canonical events
 * with `skipped: true`") with the §3 per-event whitelist, which does not list it.
 */
export const EVENT_PAYLOAD_COMMON_FIELDS = Object.freeze(['skipped']);

/**
 * The complete allowed key set for one event name.
 *
 * @param {string} name Canonical event name.
 * @returns {string[]} Allowed payload keys; empty when the name is not canonical.
 */
export function allowedPayloadFields(name) {
  const named = EVENT_PAYLOAD_FIELDS[name];
  if (!named) return [];
  return [...named, ...EVENT_PAYLOAD_COMMON_FIELDS];
}

/** Maximum events accepted in one `POST /api/v1/events` batch. */
export const EVENT_BATCH_LIMIT = 20;

/* -------------------------------------------------------------------------- */
/* Pathways (S14)                                                              */
/* -------------------------------------------------------------------------- */

/** The seven end pathways. Internal identifiers; UI labels live in the frontend copy file. */
export const PATHWAYS = Object.freeze([
  'continue_founders_edition',
  'donate_digital_transcript',
  'purchase_hardcover',
  'become_family',
  'support_mission',
  'share_opening_arc',
  'return_later',
]);

/* -------------------------------------------------------------------------- */
/* Content matrix                                                              */
/* -------------------------------------------------------------------------- */

/** ManuscriptUnit types. `front_matter` is the BUILD_CONTRACT §6 addition. */
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

/** Narrative role a unit performs inside the arc. */
export const CONTENT_ROLES = Object.freeze([
  'orientation',
  'exposure',
  'recognition',
  'decompression',
  'convergence',
  'transition',
  'invitation',
]);

/** Authored emotional tone of a unit. */
export const EMOTIONAL_TONES = Object.freeze([
  'calm',
  'grave',
  'reflective',
  'intense',
  'tender',
  'clarifying',
  'convergent',
]);

/** Editorial pipeline states shared by manuscripts, units, prompts and questionnaires. */
export const EDITORIAL_STATUSES = Object.freeze([
  'draft',
  'review',
  'approved',
  'published',
  'archived',
]);

/* -------------------------------------------------------------------------- */
/* Resonance and sharing                                                       */
/* -------------------------------------------------------------------------- */

/** Resonance node types produced by the editorial resonance-mapping pass. */
export const NODE_TYPES = Object.freeze([
  'recognition_peak',
  'decompression_window',
  'human_reconnection',
  'return_window',
  'convergence_threshold',
  'no_share_zone',
]);

/** Windows in which a sharing prompt may ever be shown. */
export const WINDOW_TYPES = Object.freeze([
  'quiet_recognition',
  'decompression',
  'human_reconnection',
  'return',
  'convergence',
]);

/** Visual treatments a sharing prompt may request. */
export const VISUAL_TREATMENTS = Object.freeze([
  'minimal',
  'quiet_inline',
  'isolated',
  'full_breath',
]);

/** Sharing prompt types. */
export const PROMPT_TYPES = Object.freeze([
  'silent',
  'soft',
  'reflective',
  'continuity',
  'threshold',
]);

/**
 * Prompt frequency. The enum has exactly one value and is locked at `rare`.
 * Widening this enum would be a Sharing-Law violation.
 */
export const PROMPT_FREQUENCIES = Object.freeze(['rare']);

/**
 * Resonance node types that may open a sharing window, in the absence of the
 * never-defined "K1.3+ threshold model". Conservative default (§9.2.3).
 */
export const SHARING_WINDOW_NODE_TYPES = Object.freeze([
  'decompression_window',
  'human_reconnection',
  'return_window',
  'convergence_threshold',
]);

/** Immersion states in which share creation may be attempted at all. */
export const SHARING_READY_IMMERSION_STATES = Object.freeze([
  'sharing_ready',
  'return',
  'convergence',
]);

/* -------------------------------------------------------------------------- */
/* Reader feedback                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Categories for free-form reader feedback.
 *
 * Frozen, because the founder review surface filters on them (§10): a category invented at
 * the client would create a bucket no reviewer ever opens. `other` is present so a reader is
 * never forced to file what they wrote under a heading that does not fit it.
 */
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

/** Recorded when a reader chooses no category. Choosing for them would be profiling-by-guess. */
export const DEFAULT_FEEDBACK_CATEGORY = 'other';

/**
 * Whether feedback stands alone or is anchored to passages the reader marked while reading.
 * Derived from the marks that arrive with the submission — never declared by the client, so
 * the kind and the passage list can never disagree.
 */
export const FEEDBACK_KINDS = Object.freeze(['general', 'passage']);

/**
 * Triage states. Staff workflow only: none of these is ever shown to the reader who wrote
 * the feedback, because "archived" is not something a person should read about their words.
 */
export const FEEDBACK_STATUSES = Object.freeze(['new', 'triaged', 'actioned', 'archived']);

/** Opening state of every submission. */
export const DEFAULT_FEEDBACK_STATUS = 'new';

/** Length and count caps for one submission (§3.13 marks are a few passages, not a corpus). */
export const FEEDBACK_BODY_MAX_LENGTH = 4000;
export const FEEDBACK_EXCERPT_MAX_LENGTH = 500;
export const FEEDBACK_MAX_PASSAGES = 20;

/* -------------------------------------------------------------------------- */
/* Beta Test Questionnaire                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The control an instrument asks a question through.
 *
 * The first four are the original vocabulary. The three added alongside them exist because
 * the v2.0 instrument asks compound questions that the original four could only express by
 * splitting one numbered question into two — which would renumber the instrument and break
 * the join between a stored answer and the question a reader was actually shown.
 *
 *  - `rated_text`  "Rate 1–5 and explain." One rating and one explanation, one question.
 *  - `chips_text`  "Choose the closest words and explain." A word set plus an explanation.
 *  - `short_text`  A single line: a reviewer code, an approximate reading time.
 *
 * `scale`, `single_choice`, `multi_choice` and `open_text` are unchanged and still valid, so
 * an instrument authored against the earlier vocabulary keeps rendering.
 */
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

/** Kinds that carry a 1–5 rating, and are therefore aggregatable. */
export const RATED_QUESTION_KINDS = Object.freeze(['scale', 'rated_text']);

/**
 * The roles a question may declare, for the handful of answers that mean something to the
 * platform as well as to the researcher.
 *
 * The instrument's reviewer metadata is stored as ordinary answers like every other
 * question, because it is asked like every other question. But four of those answers also
 * need to be filterable, sortable and — in the case of `quote_consent` — legally
 * load-bearing, so they are lifted onto their own fields on the response.
 *
 * The lift is driven by this vocabulary rather than by question identifiers, so a future
 * instrument can renumber its metadata block without the server losing track of which answer
 * grants permission to quote.
 */
export const QUESTION_ROLES = Object.freeze([
  'reviewer_name',
  'reviewer_date',
  'reading_format',
  'reading_time',
  'quote_consent',
]);

/** The instrument's fixed scale. Five points, no other scale, no half steps. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * The four formats the instrument's reviewer metadata names (§5.8).
 *
 * A reader may answer from inside the reading room or from a document they were sent, and
 * which one it was changes how their answers should be read — someone who lost the thread in
 * a PDF is reporting on the manuscript, someone who lost it in the room may be reporting on
 * the room. So the field is part of the record rather than inferred from the surface.
 */
export const READING_FORMATS = Object.freeze(['DOCX', 'PDF', 'print', 'immersive room']);

/** The format recorded for anyone who answers from inside the reading room. */
export const IMMERSIVE_READING_FORMAT = 'immersive room';

/** Caps on one questionnaire submission. */
export const ANSWER_TEXT_MAX_LENGTH = 4000;
export const ANSWER_MAX_VALUES = 40;
export const QUESTIONNAIRE_MAX_QUESTIONS = 200;

/* -------------------------------------------------------------------------- */
/* Administration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Founding Reader invitation lifecycle.
 *
 * Two vocabularies meet here and both are canon, so the enum is their union rather than a
 * replacement. The Airtable-mirroring strings are fixed by §10.7.2 ("Participant records
 * mirror the Airtable schema exactly … Status values (exact strings)"), and the platform's
 * own delivery states — `invited` when a private reading link has been sent from the
 * dashboard, `opened` when it was first followed, `revoked` when it was withdrawn — are
 * §5.7's `beta_invites` lifecycle. Dropping either set would break an existing import or an
 * existing route, so the funnel ranks them instead: see `modules/admin/beta.js`.
 */
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

/**
 * Editable email templates (§10.7.2 "send welcome email, issue private reading link").
 *
 * A closed set. The dashboard edits the copy of these messages; it cannot create new ones,
 * because a general-purpose message composer is the email campaign tooling §10.6.4 rules
 * out. Receipts and transcript deliveries are deliberately absent — their content carries
 * accounting obligations and stays in code.
 */
export const EMAIL_TEMPLATE_KEYS = Object.freeze(['beta_invitation', 'beta_welcome']);

/** Admin roles (§9.2.10). MFA is mandatory for all of them. */
export const ADMIN_ROLES = Object.freeze([
  'founder',
  'architect',
  'editor',
  'reviewer',
  'beta_coordinator',
  'finance',
]);

/**
 * World Monitor roles, reserved by §9.11 so the same auth plugin extends without a rebuild.
 * Not grantable in Phase 1.
 */
export const RESERVED_WORLD_MONITOR_ROLES = Object.freeze([
  'source_curator',
  'researcher',
  'verifier',
  'publisher',
  'methodology_admin',
]);

/** Audit actor classes. */
export const AUDIT_ACTOR_TYPES = Object.freeze(['admin', 'system', 'webhook']);

/* -------------------------------------------------------------------------- */
/* Anti-profiling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fields that may never exist on any document in any collection (BUILD_CONTRACT §5).
 * The MongoDB validators declare a closed property set, so these are structurally
 * unwritable; `test/prohibited-data.test.js` asserts none of them is ever declared.
 */
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

/** Session provenance. */
export const ENTRY_VIA = Object.freeze(['direct', 'share_token', 'invitation']);

/**
 * Motion preference recorded on the session.
 *
 * Three values, not two: §3.9's Motion setting is Full / Reduced / Off, and `off` is a real
 * destination rather than a stronger `reduced` — it stops ambient drift entirely and freezes
 * the backdrop. Motion adjustment is a mandatory affordance, so the vocabulary the reader can
 * actually choose from and the vocabulary the server accepts have to be the same one.
 */
export const MOTION_PREFERENCES = Object.freeze(['full', 'reduced', 'off']);

/** Document schema version stamped on every write by this build. */
export const SCHEMA_VERSION = 1;
