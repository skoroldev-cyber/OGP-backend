/**
 * Admin route schemas.
 *
 * The dashboard is the one surface in the platform that sees named humans and money, so
 * these shapes are drawn tightly:
 *
 * 1. **No reading trail is reachable from a person.** An invitation projection carries the
 *    invitee's details and the funnel stamps, but never `redeemedBySessionId`. The join
 *    exists in the database for completion counting; exposing it would hand an
 *    administrator a per-reader browsing view, which §10.2 prohibits outright.
 * 2. **No age dimension exists in any metrics shape.** There is no `ageBand` field and no
 *    `contentLayer` breakdown in this file, so no metric can be sliced by one — the
 *    constraint is enforced by the absence of a field rather than by a filter someone can
 *    forget.
 * 3. **No aggregate is shaped for a reader.** Every response here is behind admin auth. The
 *    counts are instruments for a decision, never numbers to render back into the
 *    experience: a completion total in reader-facing UI would be a social-proof indicator.
 * 4. **Audit diffs travel as strings.** `before` and `after` hold arbitrary shapes, and an
 *    open object would be the one place `additionalProperties: false` did not hold. They
 *    are serialised to capped JSON text instead, so the envelope stays closed.
 */

import {
  ADMIN_ROLES,
  ANSWER_TEXT_MAX_LENGTH,
  CONTENT_ROLES,
  EDITORIAL_STATUSES,
  EMAIL_TEMPLATE_KEYS,
  EMOTIONAL_TONES,
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_CATEGORIES,
  FEEDBACK_EXCERPT_MAX_LENGTH,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_PASSAGES,
  FEEDBACK_STATUSES,
  INVITATION_STATUSES,
  NODE_TYPES,
  PROMPT_FREQUENCIES,
  PROMPT_TYPES,
  QUESTION_KINDS,
  QUESTION_ROLES,
  RATING_MAX,
  RATING_MIN,
  READING_FORMATS,
  STATE_CODES,
  UNIT_TYPES,
  VISUAL_TREATMENTS,
  WINDOW_TYPES,
} from '../../config/constants.js';
import {
  amountCents,
  arraySchema,
  adminTokenHeader,
  boundedString,
  currency,
  email,
  enumOf,
  errorResponses,
  identifier,
  isoDate,
  noContentResponse,
  nullableEnumOf,
  objectSchema,
  ulid,
} from '../../lib/schemas.js';

/* -------------------------------------------------------------------------- */
/* Projection helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} value A Date, an ISO string, or nothing.
 * @returns {string|null} An ISO-8601 string, or null.
 */
export function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

/**
 * @param {unknown} value A candidate number.
 * @param {number|null} [fallback] Value when the candidate is not an integer.
 * @returns {number|null} The integer, or the fallback.
 */
export function toInteger(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback;
}

/**
 * @param {unknown} value Any value.
 * @param {number} [maxLength] Cap.
 * @returns {string|null} Compact JSON, capped, or null.
 */
export function toJsonText(value, maxLength = 4000) {
  if (value === null || value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                            */
/* -------------------------------------------------------------------------- */

export const adminHeaders = adminTokenHeader;
export const emptyResponse = noContentResponse;
export const adminErrorResponses = errorResponses(
  400,
  401,
  403,
  404,
  409,
  422,
  423,
  429,
  500,
  503,
);

const limit = Object.freeze({ type: 'integer', minimum: 1, maximum: 200, default: 50 });
const offset = Object.freeze({ type: 'integer', minimum: 0, maximum: 100_000, default: 0 });
const total = Object.freeze({ type: 'integer', minimum: 0 });
const nullableString = (maxLength) => Object.freeze({ type: ['string', 'null'], maxLength });
const nullableInteger = Object.freeze({ type: ['integer', 'null'] });
const nullableDate = Object.freeze({ type: ['string', 'null'], format: 'date-time' });
const nullableBoolean = Object.freeze({ type: ['boolean', 'null'] });

/**
 * A paginated query with optional extra filters.
 *
 * @param {Record<string, object>} [extra] Additional query properties.
 * @returns {object} The query schema.
 */
export function listQuery(extra = {}) {
  return objectSchema({ limit, offset, ...extra });
}

/** `{ id }` path parameters, used by nearly every mutation route. */
export const idParams = objectSchema({ id: identifier }, { required: ['id'] });

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

export const adminSummary = objectSchema(
  {
    id: ulid,
    email,
    displayName: nullableString(160),
    role: enumOf(ADMIN_ROLES),
    active: { type: 'boolean' },
    lastLoginAt: nullableDate,
  },
  { required: ['id', 'email', 'role', 'active'] },
);

/**
 * `POST /admin/auth/login`. Password **and** TOTP, both required, in one request — MFA is
 * mandatory for every role including the founder, so there is no intermediate state in
 * which a password alone has bought anything (§10.8.2).
 */
export const loginBody = objectSchema(
  {
    // The interim gate takes a name rather than an address, so the shape is a bounded string
    // and the *service* decides what a valid identifier is. A format assertion here would
    // reject the development sign-in before any policy had a chance to run.
    email: boundedString(320, 1),
    password: boundedString(1024, 8),
    // Optional in SHAPE, mandatory in POLICY.
    //
    // MFA is not weakened by this: `auth.js` refuses any real account whose second factor is
    // absent, unenrolled or wrong, and that check is what enforces §9.2.10. The schema only
    // stops being the thing that rejects the request, so the service can answer every failed
    // attempt with one message — which is the property that stops the form telling an attacker
    // which factor was wrong.
    totpCode: { type: 'string', pattern: '^[0-9]{6}$', minLength: 6, maxLength: 6 },
  },
  { required: ['email', 'password'] },
);

export const refreshBody = objectSchema(
  { refreshToken: boundedString(256, 16) },
  { required: ['refreshToken'] },
);

export const sessionResponse = objectSchema(
  {
    accessToken: boundedString(4096, 16),
    expiresAt: isoDate,
    refreshToken: boundedString(256, 16),
    admin: adminSummary,
  },
  { required: ['accessToken', 'expiresAt', 'refreshToken', 'admin'] },
);

/* -------------------------------------------------------------------------- */
/* Content — manuscripts                                                       */
/* -------------------------------------------------------------------------- */

const manuscriptShape = objectSchema(
  {
    id: ulid,
    title: boundedString(300, 1),
    subtitle: nullableString(300),
    edition: boundedString(64, 1),
    branch: enumOf(['public', 'confidential']),
    version: boundedString(32, 1),
    releaseId: nullableString(64),
    isCanonical: { type: 'boolean' },
    openingArcLocked: { type: 'boolean' },
    chapterCount: nullableInteger,
    contentHash: nullableString(128),
    status: enumOf(EDITORIAL_STATUSES),
    notes: nullableString(2000),
    publishedAt: nullableDate,
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'title', 'edition', 'branch', 'version', 'status'] },
);

export const manuscriptsResponse = objectSchema(
  { manuscripts: arraySchema(manuscriptShape, { maxItems: 200 }), total },
  { required: ['manuscripts', 'total'] },
);

export const manuscriptResponse = objectSchema(
  { manuscript: manuscriptShape },
  { required: ['manuscript'] },
);

export const createManuscriptBody = objectSchema(
  {
    title: boundedString(300, 1),
    subtitle: boundedString(300),
    edition: boundedString(64, 1),
    branch: enumOf(['public', 'confidential']),
    version: boundedString(32, 1),
    releaseId: boundedString(64),
    isCanonical: { type: 'boolean' },
    openingArcLocked: { type: 'boolean' },
    chapterCount: { type: 'integer', minimum: 0, maximum: 1000 },
    notes: boundedString(2000),
  },
  { required: ['title', 'edition', 'branch', 'version'] },
);

export const updateManuscriptBody = objectSchema({
  title: boundedString(300, 1),
  subtitle: boundedString(300),
  version: boundedString(32, 1),
  releaseId: boundedString(64),
  isCanonical: { type: 'boolean' },
  openingArcLocked: { type: 'boolean' },
  chapterCount: { type: 'integer', minimum: 0, maximum: 1000 },
  status: enumOf(EDITORIAL_STATUSES),
  notes: boundedString(2000),
});

export const manuscriptsQuery = listQuery({
  status: enumOf(EDITORIAL_STATUSES),
  branch: enumOf(['public', 'confidential']),
});

/* -------------------------------------------------------------------------- */
/* Content — units                                                             */
/* -------------------------------------------------------------------------- */

const emotionalMetadata = objectSchema(
  {
    emotional_intensity: nullableInteger,
    recognition_weight: nullableInteger,
    trauma_density: nullableInteger,
    cognitive_density: nullableInteger,
    hope_signal: nullableInteger,
    human_continuity_signal: nullableInteger,
    symbolic_density: nullableInteger,
    decompression_need: nullableInteger,
  },
  { nullable: true },
);

const unitShape = objectSchema(
  {
    id: ulid,
    manuscriptId: nullableString(64),
    unitId: boundedString(64, 1),
    unitType: enumOf(UNIT_TYPES),
    parentUnitId: nullableString(64),
    sequenceIndex: nullableInteger,
    componentIndex: nullableInteger,
    chapterNumber: nullableInteger,
    sectionNumber: nullableInteger,
    canonicalTitle: nullableString(300),
    contentRole: { type: ['string', 'null'], enum: [...CONTENT_ROLES, null] },
    emotionalTone: { type: ['string', 'null'], enum: [...EMOTIONAL_TONES, null] },
    isOpeningArc: { type: 'boolean' },
    isHighImpact: { type: 'boolean' },
    isNoShareZone: { type: 'boolean' },
    requiresDecompressionAfter: { type: 'boolean' },
    eligibleForResonanceMapping: { type: 'boolean' },
    emotionalMetadata,
    contentNoticeKey: nullableString(64),
    wordCount: nullableInteger,
    status: enumOf(EDITORIAL_STATUSES),
    contentVersion: nullableInteger,
    contentHash: nullableString(128),
    releaseId: nullableString(64),
    publishedAt: nullableDate,
    approvedBy: nullableString(64),
    approvedAt: nullableDate,
    blockCount: nullableInteger,
    // Present only on the single-unit read: an editor needs the text to edit it, and a list
    // of every unit does not.
    canonicalText: nullableString(400_000),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'unitId', 'unitType', 'status'] },
);

export const unitsResponse = objectSchema(
  { units: arraySchema(unitShape, { maxItems: 200 }), total },
  { required: ['units', 'total'] },
);

export const unitResponse = objectSchema({ unit: unitShape }, { required: ['unit'] });

export const unitsQuery = listQuery({
  manuscriptId: identifier,
  status: enumOf(EDITORIAL_STATUSES),
  unitType: enumOf(UNIT_TYPES),
  isOpeningArc: { type: 'boolean' },
});

/**
 * `POST /admin/units`. `canonicalText` may be supplied on creation — a unit that has never
 * been published is not yet locked. The lock applies from publication onward, for ever.
 */
export const createUnitBody = objectSchema(
  {
    manuscriptId: identifier,
    unitId: boundedString(64, 1),
    unitType: enumOf(UNIT_TYPES),
    parentUnitId: boundedString(64),
    sequenceIndex: { type: 'integer', minimum: 0, maximum: 100_000 },
    componentIndex: { type: 'integer', minimum: 0, maximum: 100 },
    chapterNumber: { type: 'integer', minimum: -1, maximum: 1000 },
    sectionNumber: { type: 'integer', minimum: 0, maximum: 1000 },
    canonicalTitle: boundedString(300),
    contentRole: enumOf(CONTENT_ROLES),
    emotionalTone: enumOf(EMOTIONAL_TONES),
    canonicalText: boundedString(400_000),
    isOpeningArc: { type: 'boolean' },
    isHighImpact: { type: 'boolean' },
    isNoShareZone: { type: 'boolean' },
    requiresDecompressionAfter: { type: 'boolean' },
    eligibleForResonanceMapping: { type: 'boolean' },
    emotionalMetadata: objectSchema({
      emotional_intensity: { type: 'integer', minimum: 0, maximum: 10 },
      recognition_weight: { type: 'integer', minimum: 0, maximum: 10 },
      trauma_density: { type: 'integer', minimum: 0, maximum: 10 },
      cognitive_density: { type: 'integer', minimum: 0, maximum: 10 },
      hope_signal: { type: 'integer', minimum: 0, maximum: 10 },
      human_continuity_signal: { type: 'integer', minimum: 0, maximum: 10 },
      symbolic_density: { type: 'integer', minimum: 0, maximum: 10 },
      decompression_need: { type: 'integer', minimum: 0, maximum: 10 },
    }),
    contentNoticeKey: boundedString(64),
    wordCount: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
  { required: ['manuscriptId', 'unitId', 'unitType', 'sequenceIndex'] },
);

/**
 * `PATCH /admin/units/:id`. `canonicalText` is declared here because an unpublished draft is
 * editable; the service rejects the field with `423` the moment the unit is a published
 * `opening_arc`, and records the attempt.
 */
export const updateUnitBody = objectSchema({
  canonicalTitle: boundedString(300),
  contentRole: enumOf(CONTENT_ROLES),
  emotionalTone: enumOf(EMOTIONAL_TONES),
  canonicalText: boundedString(400_000),
  isHighImpact: { type: 'boolean' },
  isNoShareZone: { type: 'boolean' },
  requiresDecompressionAfter: { type: 'boolean' },
  eligibleForResonanceMapping: { type: 'boolean' },
  emotionalMetadata: objectSchema({
    emotional_intensity: { type: 'integer', minimum: 0, maximum: 10 },
    recognition_weight: { type: 'integer', minimum: 0, maximum: 10 },
    trauma_density: { type: 'integer', minimum: 0, maximum: 10 },
    cognitive_density: { type: 'integer', minimum: 0, maximum: 10 },
    hope_signal: { type: 'integer', minimum: 0, maximum: 10 },
    human_continuity_signal: { type: 'integer', minimum: 0, maximum: 10 },
    symbolic_density: { type: 'integer', minimum: 0, maximum: 10 },
    decompression_need: { type: 'integer', minimum: 0, maximum: 10 },
  }),
  contentNoticeKey: boundedString(64),
  wordCount: { type: 'integer', minimum: 0, maximum: 1_000_000 },
});

export const reviewActionBody = objectSchema({ changeReason: boundedString(500) });

export const publishBody = objectSchema({ changeReason: boundedString(500) });

export const publishResponse = objectSchema(
  {
    unit: unitShape,
    version: { type: 'integer', minimum: 1 },
    cdnKey: boundedString(512, 1),
  },
  { required: ['unit', 'version', 'cdnKey'] },
);

const contentVersionShape = objectSchema(
  {
    id: ulid,
    targetCollection: boundedString(64, 1),
    targetId: boundedString(64, 1),
    version: { type: 'integer', minimum: 1 },
    publishedBy: nullableString(64),
    approvedBy: arraySchema(boundedString(64, 1), { maxItems: 10 }),
    changeReason: nullableString(500),
    publishedAt: nullableDate,
    contentHash: nullableString(128),
    cdnKey: nullableString(512),
  },
  { required: ['id', 'targetCollection', 'targetId', 'version'] },
);

export const versionsResponse = objectSchema(
  { versions: arraySchema(contentVersionShape, { maxItems: 200 }) },
  { required: ['versions'] },
);

/* -------------------------------------------------------------------------- */
/* Resonance                                                                   */
/* -------------------------------------------------------------------------- */

const resonanceScores = objectSchema(
  {
    recognition_intensity: nullableInteger,
    emotional_openness: nullableInteger,
    nervous_system_regulation: nullableInteger,
    decompression_completion: nullableInteger,
    human_continuity_signal: nullableInteger,
    sharing_readiness: nullableInteger,
    become_family_readiness: nullableInteger,
    trauma_risk: nullableInteger,
    overload_risk: nullableInteger,
  },
  { nullable: true },
);

const resonanceScoreInput = objectSchema({
  recognition_intensity: { type: 'integer', minimum: 0, maximum: 10 },
  emotional_openness: { type: 'integer', minimum: 0, maximum: 10 },
  nervous_system_regulation: { type: 'integer', minimum: 0, maximum: 10 },
  decompression_completion: { type: 'integer', minimum: 0, maximum: 10 },
  human_continuity_signal: { type: 'integer', minimum: 0, maximum: 10 },
  sharing_readiness: { type: 'integer', minimum: 0, maximum: 10 },
  become_family_readiness: { type: 'integer', minimum: 0, maximum: 10 },
  trauma_risk: { type: 'integer', minimum: 0, maximum: 10 },
  overload_risk: { type: 'integer', minimum: 0, maximum: 10 },
});

const resonanceNodeShape = objectSchema(
  {
    id: ulid,
    nodeId: boundedString(64, 1),
    manuscriptUnitId: boundedString(64, 1),
    nodeType: enumOf(NODE_TYPES),
    scores: resonanceScores,
    chapter: nullableInteger,
    section: nullableString(64),
    summary: nullableString(1000),
    validated: nullableBoolean,
    validatedBy: nullableString(64),
    validatedAt: nullableDate,
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'nodeId', 'manuscriptUnitId', 'nodeType'] },
);

export const resonanceNodesResponse = objectSchema(
  { nodes: arraySchema(resonanceNodeShape, { maxItems: 200 }), total },
  { required: ['nodes', 'total'] },
);

export const resonanceNodeResponse = objectSchema(
  { node: resonanceNodeShape },
  { required: ['node'] },
);

export const resonanceNodesQuery = listQuery({
  manuscriptUnitId: identifier,
  nodeType: enumOf(NODE_TYPES),
  validated: { type: 'boolean' },
});

export const createResonanceNodeBody = objectSchema(
  {
    nodeId: boundedString(64, 1),
    manuscriptUnitId: identifier,
    nodeType: enumOf(NODE_TYPES),
    scores: resonanceScoreInput,
    chapter: { type: 'integer', minimum: -1, maximum: 1000 },
    section: boundedString(64),
    summary: boundedString(1000),
  },
  { required: ['nodeId', 'manuscriptUnitId', 'nodeType'] },
);

export const updateResonanceNodeBody = objectSchema({
  nodeType: enumOf(NODE_TYPES),
  scores: resonanceScoreInput,
  chapter: { type: 'integer', minimum: -1, maximum: 1000 },
  section: boundedString(64),
  summary: boundedString(1000),
});

/** Validation is a human act: an administrator signs their name to it, or unsets it. */
export const validateResonanceNodeBody = objectSchema(
  { validated: { type: 'boolean' }, note: boundedString(500) },
  { required: ['validated'] },
);

/* -------------------------------------------------------------------------- */
/* Sharing prompts                                                             */
/* -------------------------------------------------------------------------- */

const sharingPromptShape = objectSchema(
  {
    id: ulid,
    promptId: boundedString(64, 1),
    promptType: enumOf(PROMPT_TYPES),
    promptText: boundedString(600, 1),
    allowedWindowTypes: arraySchema(enumOf(WINDOW_TYPES), { maxItems: 5 }),
    visualTreatment: enumOf(VISUAL_TREATMENTS),
    frequency: enumOf(PROMPT_FREQUENCIES),
    cooldownUnits: nullableInteger,
    requiresHumanReview: { type: 'boolean' },
    reviewedBy: nullableString(64),
    reviewedAt: nullableDate,
    active: { type: 'boolean' },
    notes: nullableString(1000),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'promptId', 'promptType', 'promptText', 'active'] },
);

export const sharingPromptsResponse = objectSchema(
  { prompts: arraySchema(sharingPromptShape, { maxItems: 200 }), total },
  { required: ['prompts', 'total'] },
);

export const sharingPromptResponse = objectSchema(
  { prompt: sharingPromptShape },
  { required: ['prompt'] },
);

export const sharingPromptsQuery = listQuery({
  active: { type: 'boolean' },
  promptType: enumOf(PROMPT_TYPES),
});

/**
 * `frequency` is not accepted from a client at all. The enum has exactly one value and is
 * locked at `rare`; making it writable would be a Sharing-Law violation waiting for a typo.
 */
export const createSharingPromptBody = objectSchema(
  {
    promptId: boundedString(64, 1),
    promptType: enumOf(PROMPT_TYPES),
    promptText: boundedString(600, 1),
    allowedWindowTypes: arraySchema(enumOf(WINDOW_TYPES), { maxItems: 5, minItems: 1 }),
    visualTreatment: enumOf(VISUAL_TREATMENTS),
    cooldownUnits: { type: 'integer', minimum: 0, maximum: 100 },
    requiresHumanReview: { type: 'boolean' },
    notes: boundedString(1000),
  },
  {
    required: ['promptId', 'promptType', 'promptText', 'allowedWindowTypes', 'visualTreatment'],
  },
);

export const updateSharingPromptBody = objectSchema({
  promptType: enumOf(PROMPT_TYPES),
  promptText: boundedString(600, 1),
  allowedWindowTypes: arraySchema(enumOf(WINDOW_TYPES), { maxItems: 5, minItems: 1 }),
  visualTreatment: enumOf(VISUAL_TREATMENTS),
  cooldownUnits: { type: 'integer', minimum: 0, maximum: 100 },
  requiresHumanReview: { type: 'boolean' },
  reviewed: { type: 'boolean' },
  active: { type: 'boolean' },
  notes: boundedString(1000),
});

/* -------------------------------------------------------------------------- */
/* Beta — cohorts and invitations                                              */
/* -------------------------------------------------------------------------- */

const cohortShape = objectSchema(
  {
    id: ulid,
    name: boundedString(160, 1),
    type: enumOf(['individual', 'organization']),
    organizationName: nullableString(200),
    targetSize: nullableInteger,
    questionnaireId: nullableString(64),
    manuscriptEdition: nullableString(64),
    status: enumOf(['planned', 'inviting', 'active', 'closed']),
    notes: nullableString(2000),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'name', 'type', 'status'] },
);

export const cohortsResponse = objectSchema(
  { cohorts: arraySchema(cohortShape, { maxItems: 200 }), total },
  { required: ['cohorts', 'total'] },
);

export const cohortResponse = objectSchema({ cohort: cohortShape }, { required: ['cohort'] });

export const cohortsQuery = listQuery({
  status: enumOf(['planned', 'inviting', 'active', 'closed']),
});

export const createCohortBody = objectSchema(
  {
    name: boundedString(160, 1),
    type: enumOf(['individual', 'organization']),
    organizationName: boundedString(200),
    targetSize: { type: 'integer', minimum: 1, maximum: 10_000 },
    questionnaireId: identifier,
    manuscriptEdition: boundedString(64),
    notes: boundedString(2000),
  },
  { required: ['name', 'type'] },
);

export const updateCohortBody = objectSchema({
  name: boundedString(160, 1),
  organizationName: boundedString(200),
  targetSize: { type: 'integer', minimum: 1, maximum: 10_000 },
  questionnaireId: identifier,
  manuscriptEdition: boundedString(64),
  status: enumOf(['planned', 'inviting', 'active', 'closed']),
  notes: boundedString(2000),
});

/**
 * The cohort funnel: interested → approved → link sent → redeemed → questionnaire
 * completed. Counts only. There is no per-participant reading trail in this shape, and the
 * dashboard has no route that would produce one.
 */
export const cohortSummaryResponse = objectSchema(
  {
    cohortId: ulid,
    name: boundedString(160, 1),
    targetSize: nullableInteger,
    funnel: objectSchema(
      {
        interested: total,
        approved: total,
        linkSent: total,
        redeemed: total,
        questionnaireCompleted: total,
        followUpNeeded: total,
        notSelected: total,
      },
      {
        required: [
          'interested',
          'approved',
          'linkSent',
          'redeemed',
          'questionnaireCompleted',
          'followUpNeeded',
          'notSelected',
        ],
      },
    ),
  },
  { required: ['cohortId', 'name', 'funnel'] },
);

/**
 * The whole lifecycle, not the Airtable half of it.
 *
 * §10.7.2's exact strings and §5.7's `beta_invites` delivery states are both canon, and
 * `INVITATION_STATUSES` is their union — `invited`, `opened` and `revoked` are what the
 * dashboard's own send, open and withdrawal write. Restating a shorter list here made the
 * status filter refuse three values the platform stores, and gave the resend and revoke
 * responses a declared shape their own service could not produce.
 */
const invitationStatus = enumOf(INVITATION_STATUSES);

/** No `redeemedBySessionId`. See the file header. */
const invitationShape = objectSchema(
  {
    id: ulid,
    cohortId: nullableString(64),
    code: boundedString(64, 1),
    email: nullableString(254),
    displayName: nullableString(160),
    country: nullableString(80),
    preferredLanguage: nullableString(80),
    occupationBackground: nullableString(300),
    source: nullableString(32),
    status: invitationStatus,
    redeemedAt: nullableDate,
    welcomeEmailSentAt: nullableDate,
    readingLinkSentAt: nullableDate,
    notes: nullableString(2000),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'code', 'status'] },
);

export const invitationsResponse = objectSchema(
  { invitations: arraySchema(invitationShape, { maxItems: 200 }), total },
  { required: ['invitations', 'total'] },
);

export const invitationResponse = objectSchema(
  { invitation: invitationShape },
  { required: ['invitation'] },
);

export const invitationsQuery = listQuery({
  cohortId: identifier,
  status: invitationStatus,
});

export const createInvitationBody = objectSchema(
  {
    cohortId: identifier,
    email,
    displayName: boundedString(160),
    country: boundedString(80),
    preferredLanguage: boundedString(80),
    occupationBackground: boundedString(300),
    source: enumOf(['linkedin', 'email', 'org', 'direct']),
    notes: boundedString(2000),
  },
  { required: ['email'] },
);

export const updateInvitationBody = objectSchema({
  cohortId: identifier,
  displayName: boundedString(160),
  country: boundedString(80),
  preferredLanguage: boundedString(80),
  occupationBackground: boundedString(300),
  status: invitationStatus,
  notes: boundedString(2000),
});

export const sendWelcomeResponse = objectSchema(
  {
    invitation: invitationShape,
    delivered: { type: 'boolean' },
  },
  { required: ['invitation', 'delivered'] },
);

/**
 * The Airtable bridge (§10.7.1). One-way, deduplicated by email address, and bounded by the
 * request body limit — a large export is imported in slices rather than raising the limit
 * for every route in the service.
 */
export const importBody = objectSchema(
  {
    cohortId: identifier,
    csv: boundedString(100_000, 1),
  },
  { required: ['csv'] },
);

export const importResponse = objectSchema(
  {
    imported: total,
    updated: total,
    skipped: total,
    errors: arraySchema(boundedString(300, 1), { maxItems: 50 }),
  },
  { required: ['imported', 'updated', 'skipped', 'errors'] },
);

/* -------------------------------------------------------------------------- */
/* Beta — invitation delivery                                                  */
/* -------------------------------------------------------------------------- */

/** A cohort is 15–50 people (§5.7). The ceiling is an outer bound, not a target. */
const MAX_BULK_ADDRESSES = 500;

/**
 * `POST /admin/invitations/send`.
 *
 * The addresses are bounded strings rather than `format: 'email'` fragments, deliberately.
 * One unusable address in a pasted list of fifty must come back as its own row saying so;
 * rejecting the request would discard the other forty-nine, and partial failure is the
 * normal case here rather than an exception to it. `admin/invitations.js` tests every
 * address itself and reports `invalid_address` against the one that failed.
 */
export const sendInvitationsBody = objectSchema(
  {
    emails: arraySchema(boundedString(254), { maxItems: MAX_BULK_ADDRESSES, minItems: 1 }),
    cohortId: identifier,
    // Closed here rather than left to the service: rendering an unknown key throws out of
    // the send loop, which would abandon a batch that had already written to real mailboxes.
    templateKey: enumOf(EMAIL_TEMPLATE_KEYS),
    message: boundedString(1000, 1),
  },
  { required: ['emails'] },
);

/**
 * One row per address, and the three counts the panel reads back.
 *
 * `reason` is a short closed-ish token (`already_invited`, `invalid_address`, a lowercased
 * mail code), never a relay's reply: an SMTP diagnostic can quote the address it refused,
 * and this shape is rendered in a browser and written to a log (§9.10).
 */
export const sendInvitationsResponse = objectSchema(
  {
    results: arraySchema(
      objectSchema(
        {
          email: boundedString(254),
          status: enumOf(['sent', 'skipped', 'failed']),
          reason: nullableString(64),
        },
        { required: ['email', 'status', 'reason'] },
      ),
      { maxItems: MAX_BULK_ADDRESSES },
    ),
    sent: total,
    skipped: total,
    failed: total,
  },
  { required: ['results', 'sent', 'skipped', 'failed'] },
);

/** `POST /admin/invitations/:id/resend` — the deliberate, single, audited repeat. */
export const resendInvitationBody = objectSchema({
  templateKey: enumOf(EMAIL_TEMPLATE_KEYS),
});

/**
 * `POST /admin/invitations/:id/revoke`. The reason reaches the audit trail and nothing else:
 * §10.7.2 requires a leaked link to be withdrawable, not the participant to be written to
 * about it.
 */
export const revokeInvitationBody = objectSchema({ reason: boundedString(300, 1) });

/* -------------------------------------------------------------------------- */
/* Email templates                                                             */
/* -------------------------------------------------------------------------- */

const TEMPLATE_SUBJECT_MAX = 300;
const TEMPLATE_TEXT_MAX = 20_000;
const TEMPLATE_HTML_MAX = 40_000;

/**
 * The key is a bounded identifier rather than an enum of the closed set, so "that template
 * does not exist" has exactly one owner. `admin/templates.js` answers an unknown key with a
 * `404` naming it; a schema would answer only that validation failed, which tells a founder
 * who mistyped a key nothing at all.
 */
export const templateKeyParams = objectSchema({ key: identifier }, { required: ['key'] });

const templateShape = objectSchema(
  {
    key: enumOf(EMAIL_TEMPLATE_KEYS),
    subject: boundedString(TEMPLATE_SUBJECT_MAX, 1),
    bodyText: boundedString(TEMPLATE_TEXT_MAX, 1),
    // Null is a real choice: a template stored without HTML goes out as plain text only.
    bodyHtml: nullableString(TEMPLATE_HTML_MAX),
    version: { type: 'integer', minimum: 1 },
    updatedBy: nullableString(64),
    updatedAt: nullableDate,
    // The names the renderer knows, echoed so the editor lists them from the server rather
    // than keeping a second copy of a vocabulary that can drift.
    placeholders: arraySchema(boundedString(64, 1), { maxItems: 10 }),
  },
  { required: ['key', 'subject', 'bodyText', 'bodyHtml', 'version', 'placeholders'] },
);

export const templatesResponse = objectSchema(
  { templates: arraySchema(templateShape, { maxItems: EMAIL_TEMPLATE_KEYS.length }) },
  { required: ['templates'] },
);

export const templateResponse = objectSchema(
  { template: templateShape },
  { required: ['template'] },
);

/**
 * `PUT /admin/templates/:key`. The key is absent from the body: a template is edited where
 * it lives, and a body that could name a different key than the path is a way to write to
 * the wrong message.
 */
export const updateTemplateBody = objectSchema(
  {
    subject: boundedString(TEMPLATE_SUBJECT_MAX, 1),
    bodyText: boundedString(TEMPLATE_TEXT_MAX, 1),
    bodyHtml: nullableString(TEMPLATE_HTML_MAX),
  },
  { required: ['subject', 'bodyText'] },
);

/**
 * `POST /admin/templates/:key/preview`. Every field is optional — an empty body renders what
 * is stored, and a populated one renders a draft that has not been saved yet.
 */
export const previewTemplateBody = objectSchema({
  subject: boundedString(TEMPLATE_SUBJECT_MAX, 1),
  bodyText: boundedString(TEMPLATE_TEXT_MAX, 1),
  bodyHtml: nullableString(TEMPLATE_HTML_MAX),
});

/**
 * The rendered message. Sample values only: a preview that could be pointed at a real
 * participant would be a way to read a named person's details out of the invitations
 * collection, which no route on this surface offers.
 */
export const templatePreviewResponse = objectSchema(
  {
    preview: objectSchema(
      {
        subject: boundedString(TEMPLATE_SUBJECT_MAX),
        text: boundedString(TEMPLATE_TEXT_MAX),
        html: nullableString(TEMPLATE_HTML_MAX),
      },
      { required: ['subject', 'text', 'html'] },
    ),
  },
  { required: ['preview'] },
);

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

const questionShape = objectSchema(
  {
    questionId: boundedString(64, 1),
    order: { type: 'integer', minimum: 0, maximum: 500 },
    kind: enumOf(QUESTION_KINDS),
    prompt: boundedString(2000, 1),
    label: nullableString(200),
    section: nullableString(64),
    scaleLegend: nullableString(500),
    role: nullableEnumOf(QUESTION_ROLES),
    options: { type: ['array', 'null'], items: boundedString(300, 1), maxItems: 50 },
    required: { type: 'boolean' },
  },
  { required: ['questionId', 'order', 'kind', 'prompt', 'required'] },
);

const questionnaireSectionShape = objectSchema(
  {
    key: boundedString(64, 1),
    title: boundedString(200, 1),
    description: nullableString(1000),
  },
  { required: ['key', 'title'] },
);

const questionnaireShape = objectSchema(
  {
    id: ulid,
    title: boundedString(300, 1),
    version: boundedString(32, 1),
    status: enumOf(['active', 'archived']),
    purpose: nullableString(2000),
    instruction: nullableString(2000),
    scaleLegend: nullableString(500),
    sections: arraySchema(questionnaireSectionShape, { maxItems: 20 }),
    questions: arraySchema(questionShape, { maxItems: 200 }),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'title', 'version', 'status', 'questions'] },
);

export const questionnairesResponse = objectSchema(
  { questionnaires: arraySchema(questionnaireShape, { maxItems: 100 }), total },
  { required: ['questionnaires', 'total'] },
);

export const questionnaireResponseEnvelope = objectSchema(
  { questionnaire: questionnaireShape },
  { required: ['questionnaire'] },
);

export const questionnairesQuery = listQuery({ status: enumOf(['active', 'archived']) });

export const createQuestionnaireBody = objectSchema(
  {
    title: boundedString(300, 1),
    version: boundedString(32, 1),
    purpose: boundedString(2000),
    instruction: boundedString(2000),
    scaleLegend: boundedString(500),
    sections: arraySchema(
      objectSchema(
        {
          key: boundedString(64, 1),
          title: boundedString(200, 1),
          description: boundedString(1000),
        },
        { required: ['key', 'title'] },
      ),
      { maxItems: 20 },
    ),
    questions: arraySchema(
      objectSchema(
        {
          questionId: boundedString(64, 1),
          order: { type: 'integer', minimum: 0, maximum: 500 },
          kind: enumOf(QUESTION_KINDS),
          prompt: boundedString(2000, 1),
          label: boundedString(200),
          section: boundedString(64),
          scaleLegend: boundedString(500),
          role: enumOf(QUESTION_ROLES),
          options: arraySchema(boundedString(300, 1), { maxItems: 50 }),
          required: { type: 'boolean' },
        },
        { required: ['questionId', 'order', 'kind', 'prompt'] },
      ),
      { maxItems: 200, minItems: 1 },
    ),
  },
  { required: ['title', 'version', 'questions'] },
);

export const updateQuestionnaireBody = objectSchema({
  title: boundedString(300, 1),
  status: enumOf(['active', 'archived']),
});

const answerShape = objectSchema(
  {
    questionId: boundedString(64, 1),
    text: nullableString(ANSWER_TEXT_MAX_LENGTH),
    rating: { type: ['integer', 'null'], minimum: RATING_MIN, maximum: RATING_MAX },
    values: arraySchema(boundedString(500, 1), { maxItems: 50 }),
  },
  { required: ['questionId'] },
);

/**
 * The instrument's reviewer metadata, as the panel reads it.
 *
 * `quoteConsent` is nullable on purpose and must stay nullable: `false` is a reviewer who
 * declined, `null` is a reviewer who never answered, and a screen that cannot tell them
 * apart is a screen somebody will eventually quote from.
 */
const reviewerShape = objectSchema({
  name: nullableString(200),
  completedOn: nullableString(32),
  readingTime: nullableString(120),
  quoteConsent: { type: ['boolean', 'null'] },
});

const questionnaireResponseShape = objectSchema(
  {
    id: ulid,
    questionnaireId: boundedString(64, 1),
    cohortId: nullableString(64),
    invitationId: nullableString(64),
    readingFormat: nullableString(64),
    completedAt: nullableDate,
    reviewer: reviewerShape,
    answers: arraySchema(answerShape, { maxItems: 200 }),
  },
  { required: ['id', 'questionnaireId', 'answers'] },
);

export const questionnaireResponsesResponse = objectSchema(
  { responses: arraySchema(questionnaireResponseShape, { maxItems: 200 }), total },
  { required: ['responses', 'total'] },
);

/**
 * One response with the instrument it was answered against, so the screen can show each
 * question as the reviewer saw it — including for a version since archived and reworded.
 */
export const questionnaireResponseDetailResponse = objectSchema(
  {
    response: questionnaireResponseShape,
    questionnaire: { ...questionnaireShape, type: ['object', 'null'] },
  },
  { required: ['response'] },
);

const ratingDistributionShape = objectSchema(
  { rating: { type: 'integer', minimum: RATING_MIN, maximum: RATING_MAX }, count: total },
  { required: ['rating', 'count'] },
);

export const questionnaireResponseSummaryResponse = objectSchema(
  {
    total,
    byReadingFormat: arraySchema(
      objectSchema(
        { readingFormat: enumOf(READING_FORMATS), count: total },
        { required: ['readingFormat', 'count'] },
      ),
      { maxItems: 10 },
    ),
    quoteConsent: objectSchema(
      { granted: total, declined: total, notAnswered: total },
      { required: ['granted', 'declined', 'notAnswered'] },
    ),
    byQuestion: arraySchema(
      objectSchema(
        {
          questionId: boundedString(64, 1),
          label: nullableString(200),
          prompt: boundedString(2000, 1),
          answered: total,
          average: { type: ['number', 'null'], minimum: 0, maximum: RATING_MAX },
          distribution: arraySchema(ratingDistributionShape, { maxItems: 5 }),
        },
        { required: ['questionId', 'prompt', 'answered', 'distribution'] },
      ),
      { maxItems: 200 },
    ),
  },
  { required: ['total', 'byReadingFormat', 'quoteConsent', 'byQuestion'] },
);

/**
 * The filters the listing, the summary and the export all accept.
 *
 * One declaration for the three routes on purpose. A summary computed over a wider set than
 * the table beneath it would be quietly wrong in the direction people act on, and an export
 * that ignored a filter would carry more reviewers' words out of the platform than the
 * operator asked for.
 */
const responseFilters = {
  cohortId: identifier,
  questionnaireId: identifier,
  readingFormat: enumOf(READING_FORMATS),
  quoteConsent: enumOf(['granted', 'declined', 'not_answered']),
  q: boundedString(200, 1),
  from: isoDate,
  to: isoDate,
};

export const questionnaireResponsesQuery = listQuery({ ...responseFilters });

/** Paging is meaningless for an aggregate and for an export; both take filters only. */
export const questionnaireResponseSummaryQuery = objectSchema({ ...responseFilters });

export const questionnaireResponsesExportQuery = questionnaireResponseSummaryQuery;

/* -------------------------------------------------------------------------- */
/* Free-form feedback                                                          */
/* -------------------------------------------------------------------------- */

const feedbackPassageShape = objectSchema(
  {
    unitId: boundedString(64, 1),
    componentIndex: nullableInteger,
    excerpt: nullableString(FEEDBACK_EXCERPT_MAX_LENGTH),
    charStart: nullableInteger,
    charEnd: nullableInteger,
  },
  { required: ['unitId'] },
);

/**
 * One feedback record as the dashboard sees it.
 *
 * There is no `sessionId` here and no reading-progress field of any kind, for the reason
 * given in the file header: a reviewer reads what a person wrote, never where they were.
 * There is likewise no `ageBand` and no `contentLayer` — the band is session state, and a
 * feedback record that carried it beside an email address would break the §9.2.7 wall.
 */
const feedbackShape = objectSchema(
  {
    id: ulid,
    kind: enumOf(FEEDBACK_KINDS),
    category: enumOf(FEEDBACK_CATEGORIES),
    status: enumOf(FEEDBACK_STATUSES),
    body: boundedString(FEEDBACK_BODY_MAX_LENGTH, 1),
    displayName: nullableString(160),
    // Null unless the reader consented to contact — the document holds no address without it.
    email: nullableString(254),
    contactConsent: { type: 'boolean' },
    passages: arraySchema(feedbackPassageShape, { maxItems: FEEDBACK_MAX_PASSAGES }),
    releaseId: nullableString(64),
    readingFormat: nullableString(32),
    cohortId: nullableString(64),
    invitationId: nullableString(64),
    adminNotes: nullableString(4000),
    createdAt: nullableDate,
    updatedAt: nullableDate,
  },
  { required: ['id', 'kind', 'category', 'status', 'body', 'contactConsent', 'passages'] },
);

export const feedbackResponse = objectSchema({ feedback: feedbackShape }, { required: ['feedback'] });

export const feedbackListResponse = objectSchema(
  {
    feedback: arraySchema(feedbackShape, { maxItems: 200 }),
    total,
    page: { type: 'integer', minimum: 1 },
  },
  { required: ['feedback', 'total', 'page'] },
);

/**
 * A numeric query parameter, declared as digits.
 *
 * The platform's Ajv runs with `coerceTypes: false` — deliberately, so that `"true"` in a
 * request body never becomes `true`. A query string carries no types at all, so a parameter
 * declared as `integer` there can only ever be rejected. It is declared as bounded digits
 * instead and converted once, in the service.
 *
 * @param {number} maxDigits Widest accepted value, in digits.
 * @returns {object} The fragment.
 */
const digits = (maxDigits) =>
  Object.freeze({ type: 'string', pattern: `^[1-9][0-9]{0,${maxDigits - 1}}$`, maxLength: maxDigits });

/**
 * Paged by page number rather than by offset: the queue is read as pages of a review list,
 * and the two ways of saying the same thing should not both be accepted on one route.
 */
export const feedbackQuery = objectSchema({
  limit: digits(3),
  page: digits(4),
  status: enumOf(FEEDBACK_STATUSES),
  category: enumOf(FEEDBACK_CATEGORIES),
  cohortId: identifier,
  unitId: identifier,
  q: boundedString(200, 1),
  from: isoDate,
  to: isoDate,
});

/** The export takes the same filters and no paging: it is the whole filtered set. */
export const feedbackExportQuery = objectSchema({
  status: enumOf(FEEDBACK_STATUSES),
  category: enumOf(FEEDBACK_CATEGORIES),
  cohortId: identifier,
  unitId: identifier,
  q: boundedString(200, 1),
  from: isoDate,
  to: isoDate,
});

/**
 * Triage only. `body`, `category`, `passages` and the contact fields are absent, so what a
 * reader wrote cannot be edited by the people reviewing it.
 */
export const updateFeedbackBody = objectSchema({
  status: enumOf(FEEDBACK_STATUSES),
  adminNotes: boundedString(4000),
});

/**
 * Aggregate counts, and nothing else. Every array here is keyed by a vocabulary or by a
 * manuscript unit; none of them is keyed by a person, and none can be (§10.2).
 */
export const feedbackSummaryResponse = objectSchema(
  {
    total,
    byCategory: arraySchema(
      objectSchema({ category: enumOf(FEEDBACK_CATEGORIES), count: total }, {
        required: ['category', 'count'],
      }),
      { maxItems: FEEDBACK_CATEGORIES.length },
    ),
    byStatus: arraySchema(
      objectSchema({ status: enumOf(FEEDBACK_STATUSES), count: total }, {
        required: ['status', 'count'],
      }),
      { maxItems: FEEDBACK_STATUSES.length },
    ),
    byUnit: arraySchema(
      objectSchema({ unitId: boundedString(64, 1), count: total }, {
        required: ['unitId', 'count'],
      }),
      { maxItems: 200 },
    ),
  },
  { required: ['total', 'byCategory', 'byStatus', 'byUnit'] },
);

/**
 * The CSV body. Declared as a string so the route still carries a response schema, but the
 * handler sends a Buffer — Fastify serialises only what it is asked to serialise, and a JSON
 * serialiser applied to a CSV document would quote and escape the whole file.
 */
export const csvResponse = Object.freeze({ type: 'string' });

/* -------------------------------------------------------------------------- */
/* Commerce                                                                    */
/* -------------------------------------------------------------------------- */

const refundLine = objectSchema(
  {
    amountCents,
    reason: nullableString(300),
    at: nullableDate,
    byAdminId: nullableString(64),
  },
  { required: ['amountCents'] },
);

/**
 * Contributions and orders have separate list shapes, separate routes and separate exports.
 * There is no combined revenue view anywhere in this file, by design (§10.4.5).
 */
const donationShape = objectSchema(
  {
    id: ulid,
    kind: enumOf(['digital_transcript_access', 'support_mission']),
    amountCents,
    currency,
    status: boundedString(32, 1),
    anonymous: { type: 'boolean' },
    email: nullableString(254),
    receiptNumber: nullableString(32),
    transactionId: nullableString(64),
    digitalAccessGrantId: nullableString(64),
    refunds: arraySchema(refundLine, { maxItems: 50 }),
    capturedAt: nullableDate,
    refundedAt: nullableDate,
    createdAt: nullableDate,
  },
  { required: ['id', 'kind', 'amountCents', 'currency', 'status'] },
);

export const donationsResponse = objectSchema(
  { donations: arraySchema(donationShape, { maxItems: 200 }), total },
  { required: ['donations', 'total'] },
);

export const donationsQuery = listQuery({
  status: boundedString(32, 1),
  kind: enumOf(['digital_transcript_access', 'support_mission']),
  from: isoDate,
  to: isoDate,
});

const orderShape = objectSchema(
  {
    id: ulid,
    orderNumber: nullableString(32),
    type: enumOf(['purchase', 'reservation', 'reserve']),
    productSku: nullableString(64),
    quantity: nullableInteger,
    amountCents: { type: ['integer', 'null'], minimum: 0 },
    currency: nullableString(8),
    status: boundedString(32, 1),
    email: nullableString(254),
    trackingNumber: nullableString(120),
    receiptNumber: nullableString(32),
    transactionId: nullableString(64),
    refunds: arraySchema(refundLine, { maxItems: 50 }),
    notifiedAt: nullableDate,
    paidAt: nullableDate,
    shippedAt: nullableDate,
    createdAt: nullableDate,
  },
  { required: ['id', 'type', 'status'] },
);

export const ordersResponse = objectSchema(
  { orders: arraySchema(orderShape, { maxItems: 200 }), total },
  { required: ['orders', 'total'] },
);

export const ordersQuery = listQuery({
  status: boundedString(32, 1),
  type: enumOf(['purchase', 'reservation']),
  from: isoDate,
  to: isoDate,
});

export const orderResponse = objectSchema({ order: orderShape }, { required: ['order'] });

/**
 * `revokeAccess` defaults to false and must be asked for explicitly: §6.8 revokes a
 * transcript grant only when a contribution is reported as made in error, and leaves access
 * intact for a goodwill reversal.
 */
export const refundBody = objectSchema(
  {
    amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    reason: boundedString(300, 1),
    revokeAccess: { type: 'boolean' },
  },
  { required: ['reason'] },
);

export const refundResponse = objectSchema(
  {
    refund: objectSchema(
      {
        status: enumOf([
          'refunded',
          'partially_refunded',
          'voided',
          'authorization_recorded',
        ]),
        amountCents,
        transactionId: nullableString(64),
        authorizationsHeld: { type: 'integer', minimum: 0 },
        authorizationsRequired: { type: 'integer', minimum: 1 },
        accessRevoked: { type: 'boolean' },
      },
      {
        required: [
          'status',
          'amountCents',
          'authorizationsHeld',
          'authorizationsRequired',
          'accessRevoked',
        ],
      },
    ),
  },
  { required: ['refund'] },
);

export const fulfillBody = objectSchema(
  {
    trackingNumber: boundedString(120, 1),
    carrier: boundedString(80),
  },
  { required: ['trackingNumber'] },
);

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

const funnelStep = objectSchema(
  {
    state: enumOf(STATE_CODES),
    event: boundedString(64, 1),
    sessions: total,
    stepConversion: { type: ['number', 'null'] },
    cumulativeConversion: { type: ['number', 'null'] },
  },
  { required: ['state', 'event', 'sessions'] },
);

export const funnelQuery = objectSchema({ from: isoDate, to: isoDate });

export const funnelResponse = objectSchema(
  {
    from: nullableDate,
    to: nullableDate,
    steps: arraySchema(funnelStep, { maxItems: 20 }),
  },
  { required: ['steps'] },
);

export const eventsMetricQuery = objectSchema({
  name: boundedString(64, 1),
  bucket: enumOf(['day']),
  from: isoDate,
  to: isoDate,
});

export const eventsMetricResponse = objectSchema(
  {
    bucket: enumOf(['day']),
    series: arraySchema(
      objectSchema(
        {
          bucket: boundedString(10, 10),
          name: boundedString(64, 1),
          count: total,
        },
        { required: ['bucket', 'name', 'count'] },
      ),
      { maxItems: 1000 },
    ),
  },
  { required: ['bucket', 'series'] },
);

export const cohortMetricsResponse = objectSchema(
  {
    cohortId: ulid,
    funnel: objectSchema(
      {
        interested: total,
        approved: total,
        linkSent: total,
        redeemed: total,
        questionnaireCompleted: total,
        followUpNeeded: total,
        notSelected: total,
      },
      {
        required: [
          'interested',
          'approved',
          'linkSent',
          'redeemed',
          'questionnaireCompleted',
          'followUpNeeded',
          'notSelected',
        ],
      },
    ),
    reading: objectSchema(
      {
        sessionsStarted: total,
        openingArcCompleted: total,
      },
      { required: ['sessionsStarted', 'openingArcCompleted'] },
    ),
  },
  { required: ['cohortId', 'funnel', 'reading'] },
);

/* -------------------------------------------------------------------------- */
/* Ops                                                                         */
/* -------------------------------------------------------------------------- */

export const healthDetailResponse = objectSchema(
  {
    status: enumOf(['ok', 'degraded']),
    environment: boundedString(32, 1),
    database: objectSchema(
      { ok: { type: 'boolean' }, latencyMs: nullableInteger },
      { required: ['ok', 'latencyMs'] },
    ),
    flags: objectSchema(
      {
        ageLayerEnabled: { type: 'boolean' },
        freeAccessEnabled: { type: 'boolean' },
        hardcoverPurchasable: { type: 'boolean' },
        sharingEnabled: { type: 'boolean' },
      },
      {
        required: [
          'ageLayerEnabled',
          'freeAccessEnabled',
          'hardcoverPurchasable',
          'sharingEnabled',
        ],
      },
    ),
    mail: objectSchema({ transport: boundedString(16, 1) }, { required: ['transport'] }),
    // Whether the gateway is live or mocked. No key, no key fingerprint, no endpoint.
    gateway: objectSchema(
      { mode: enumOf(['live', 'mock']) },
      { required: ['mode'] },
    ),
    counts: arraySchema(
      objectSchema(
        { collection: boundedString(64, 1), documents: total },
        { required: ['collection', 'documents'] },
      ),
      { maxItems: 40 },
    ),
  },
  { required: ['status', 'environment', 'database', 'flags', 'mail', 'gateway', 'counts'] },
);

const auditEntryShape = objectSchema(
  {
    id: ulid,
    actorType: enumOf(['admin', 'system', 'webhook']),
    actorId: nullableString(64),
    action: boundedString(120, 1),
    targetCollection: nullableString(64),
    targetId: nullableString(64),
    correlationId: nullableString(64),
    before: nullableString(4100),
    after: nullableString(4100),
    at: nullableDate,
  },
  { required: ['id', 'actorType', 'action'] },
);

export const auditQuery = listQuery({
  target: identifier,
  targetId: identifier,
  action: boundedString(120, 1),
  actorId: identifier,
  from: isoDate,
  to: isoDate,
});

export const auditResponse = objectSchema(
  { entries: arraySchema(auditEntryShape, { maxItems: 200 }), total },
  { required: ['entries', 'total'] },
);
