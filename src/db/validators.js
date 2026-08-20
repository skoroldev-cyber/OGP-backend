import { COLLECTIONS } from './collections.js';
import {
  ADMIN_ROLES,
  AGE_BANDS,
  AUDIT_ACTOR_TYPES,
  CONTENT_LAYERS,
  CONTENT_ROLES,
  EDITORIAL_STATUSES,
  EMOTIONAL_TONES,
  ENTRY_VIA,
  EVENT_NAMES,
  EVENT_PAYLOAD_COMMON_FIELDS,
  EVENT_PAYLOAD_FIELDS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  IMMERSION_STATES,
  INVITATION_STATUSES,
  MOTION_PREFERENCES,
  NODE_TYPES,
  PACE_MODES,
  PATHWAYS,
  PROHIBITED_FIELDS,
  PROMPT_FREQUENCIES,
  PROMPT_TYPES,
  QUESTION_KINDS,
  QUESTION_ROLES,
  READING_FORMATS,
  STATE_CODES,
  UNIT_TYPES,
  VISUAL_TREATMENTS,
  WINDOW_TYPES,
} from '../config/constants.js';

const str = { bsonType: 'string' };
const strOrNull = { bsonType: ['string', 'null'] };
const date = { bsonType: 'date' };
const dateOrNull = { bsonType: ['date', 'null'] };
const bool = { bsonType: 'bool' };
const boolOrNull = { bsonType: ['bool', 'null'] };
const num = { bsonType: ['int', 'long', 'double'] };
const numOrNull = { bsonType: ['int', 'long', 'double', 'null'] };
const openObject = { bsonType: 'object' };
const openObjectOrNull = { bsonType: ['object', 'null'] };

const enumOf = (values) => ({ bsonType: 'string', enum: [...values] });
const enumOrNull = (values) => ({ bsonType: ['string', 'null'], enum: [...values, null] });
const arrayOf = (items) => ({ bsonType: 'array', items });
const stringArray = arrayOf(str);
const numberArray = arrayOf(num);

const closed = (properties, required = []) => ({
  bsonType: 'object',
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
});

const closedOrNull = (properties, required = []) => ({
  bsonType: ['object', 'null'],
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
});

const STAMPS = {
  _id: str,
  createdAt: date,
  updatedAt: date,
  schemaVersion: num,
};

const documentSchema = (properties) =>
  closed({ ...STAMPS, ...properties }, ['_id']);

const NMI_RESULT = closedOrNull({
  transactionId: strOrNull,
  authCode: strOrNull,
  responseCode: strOrNull,
  responseText: strOrNull,
  avsResult: strOrNull,
  cvvResult: strOrNull,
  cardBrand: strOrNull,
  last4: strOrNull,
  customerVaultId: strOrNull,
});

const REFUND_ENTRY = closed({
  nmiTransactionId: strOrNull,
  amountCents: num,
  reason: strOrNull,
  at: date,
  byAdminId: strOrNull,
});

const SHIPPING_ADDRESS = closedOrNull({
  name: strOrNull,
  line1: str,
  line2: strOrNull,
  city: str,
  region: strOrNull,
  postalCode: strOrNull,
  country: str,
});

const DONATION_KINDS = ['digital_transcript_access', 'support_mission'];
const DONATION_STATUSES = [
  'initiated',
  'pending',
  'captured',
  'succeeded',
  'failed',
  'declined',
  'refunded',
  'partially_refunded',
];
const ORDER_TYPES = ['purchase', 'reservation', 'reserve'];
const ORDER_STATUSES = [
  'reserved',
  'notified',
  'converted',
  'created',
  'pending',
  'paid',
  'fulfillment_hold',
  'shipped',
  'delivered',
  'canceled',
  'refunded',
  'partially_refunded',
];
const PRODUCT_TYPES = [
  'hardcover',
  'softcover',
  'digital_transcript',
  'collector',
  'founders',
  'archival',
  'gift',
];
const PRODUCT_STATUSES = ['draft', 'reservable', 'purchasable', 'retired'];
const MANUSCRIPT_EDITIONS = [
  'public_founding',
  'confidential_development',
  'beta_reader_v2_0',
  'founders_edition',
  'expanded_27',
];
const COHORT_STATUSES = ['planned', 'inviting', 'active', 'closed'];
const INTENSITY_LEVELS = ['low', 'medium', 'high'];

const EVENT_PAYLOAD_PROPERTIES = (() => {
  const keys = new Set(EVENT_PAYLOAD_COMMON_FIELDS);
  for (const fields of Object.values(EVENT_PAYLOAD_FIELDS)) {
    for (const field of fields) keys.add(field);
  }
  const properties = {};
  for (const key of keys) {
    properties[key] = { bsonType: ['string', 'int', 'long', 'double', 'bool', 'null'] };
  }
  properties.pathway = enumOrNull(PATHWAYS);
  return properties;
})();

const manuscripts = documentSchema({
  title: str,
  subtitle: strOrNull,
  edition: enumOf(MANUSCRIPT_EDITIONS),
  branch: enumOf(['public', 'confidential']),
  version: str,
  releaseId: strOrNull,
  isCanonical: bool,
  openingArcLocked: bool,
  chapterCount: numOrNull,
  contentHash: strOrNull,
  status: enumOf(EDITORIAL_STATUSES),
  notes: strOrNull,
  publishedAt: dateOrNull,
});

const manuscriptUnits = documentSchema({
  manuscriptId: str,
  unitId: str,
  unit_type: enumOf(UNIT_TYPES),
  parent_unit_id: strOrNull,
  sequence_index: num,
  componentIndex: numOrNull,
  chapter_id: strOrNull,
  section_id: strOrNull,
  chapter_number: numOrNull,
  section_number: numOrNull,
  canonical_title: strOrNull,
  core_truth: strOrNull,
  themes: stringArray,
  intensity_level: enumOrNull(INTENSITY_LEVELS),
  adult_concepts: stringArray,
  youth_safe_concepts: stringArray,
  content_role: enumOrNull(CONTENT_ROLES),
  emotional_tone: enumOrNull(EMOTIONAL_TONES),
  canonicalText: strOrNull,
  blocks: arrayOf(openObject),
  versions: closedOrNull({
    age_8_12: openObjectOrNull,
    age_13_16: openObjectOrNull,
    age_17_19: openObjectOrNull,
    age_20_25: openObjectOrNull,
    age_26_32: openObjectOrNull,
    age_33_plus: openObjectOrNull,
  }),
  is_opening_arc: bool,
  is_high_impact: bool,
  is_no_share_zone: bool,
  requires_decompression_after: bool,
  eligible_for_resonance_mapping: bool,
  emotional_metadata: closedOrNull({
    emotional_intensity: numOrNull,
    recognition_weight: numOrNull,
    trauma_density: numOrNull,
    cognitive_density: numOrNull,
    hope_signal: numOrNull,
    human_continuity_signal: numOrNull,
    symbolic_density: numOrNull,
    decompression_need: numOrNull,
  }),
  contentNoticeKey: strOrNull,
  word_count: numOrNull,
  page_start: numOrNull,
  page_end: numOrNull,
  status: enumOf(EDITORIAL_STATUSES),
  contentVersion: num,
  contentHash: strOrNull,
  releaseId: strOrNull,
  publishedAt: dateOrNull,
  approvedBy: strOrNull,
  approvedAt: dateOrNull,
});

const resonanceNodes = documentSchema({
  node_id: str,
  manuscript_unit_id: str,
  node_type: enumOf(NODE_TYPES),
  scores: closedOrNull({
    recognition_intensity: numOrNull,
    emotional_openness: numOrNull,
    nervous_system_regulation: numOrNull,
    decompression_completion: numOrNull,
    human_continuity_signal: numOrNull,
    sharing_readiness: numOrNull,
    become_family_readiness: numOrNull,
    trauma_risk: numOrNull,
    overload_risk: numOrNull,
  }),
  chapter: numOrNull,
  section: strOrNull,
  summary: strOrNull,
  qa_status: closedOrNull({
    validated: boolOrNull,
    validatedBy: strOrNull,
    validatedAt: dateOrNull,
  }),
});

const readingSessions = documentSchema({
  tokenHash: str,
  ageBand: enumOrNull(AGE_BANDS),
  contentLayer: enumOrNull(CONTENT_LAYERS),
  currentState: enumOrNull(STATE_CODES),
  immersion_state: enumOrNull(IMMERSION_STATES),
  pace_mode: enumOrNull(PACE_MODES),
  progress: closedOrNull({
    currentUnitId: strOrNull,
    completedUnitIds: stringArray,
    openingArcCompleted: boolOrNull,
    chaptersCompleted: numberArray,
    savedPassageUnitIds: stringArray,
    scrollFraction: numOrNull,
    readingMs: numOrNull,
    lastReadAt: dateOrNull,
  }),
  gates: closedOrNull({
    allow_prompting: boolOrNull,
    allow_sharing: boolOrNull,
    allow_become_family: boolOrNull,
  }),
  lastDecompressionAt: dateOrNull,
  lastPromptAt: dateOrNull,
  promptsShown: numOrNull,
  sharesCreated: numOrNull,
  unitsSinceLastPrompt: numOrNull,
  entryVia: enumOrNull(ENTRY_VIA),
  cohortId: strOrNull,
  invitationId: strOrNull,
  isFoundingReader: boolOrNull,
  motionPreference: enumOrNull(MOTION_PREFERENCES),
  audioEnabled: boolOrNull,
  skipUsed: boolOrNull,
  pathwaySelected: enumOrNull(PATHWAYS),
  pathwaySelectedAt: dateOrNull,
  expiresAt: dateOrNull,
});

const events = documentSchema({
  sessionId: strOrNull,
  name: enumOf(EVENT_NAMES),
  occurredAt: dateOrNull,
  receivedAt: date,
  payload: closedOrNull(EVENT_PAYLOAD_PROPERTIES),
  contentLayer: enumOrNull(CONTENT_LAYERS),
  appVersion: strOrNull,
});

const sharingPrompts = documentSchema({
  prompt_id: str,
  prompt_type: enumOf(PROMPT_TYPES),
  prompt_text: str,
  allowed_window_types: arrayOf(enumOf(WINDOW_TYPES)),
  visual_treatment: enumOf(VISUAL_TREATMENTS),
  frequency: enumOf(PROMPT_FREQUENCIES),
  cooldown_units: numOrNull,
  requires_human_review: bool,
  reviewedBy: strOrNull,
  reviewedAt: dateOrNull,
  active: bool,
  notes: strOrNull,
});

const shareTokens = documentSchema({
  token: str,
  createdBySessionId: strOrNull,
  createdAtUnitId: strOrNull,
  promptId: strOrNull,
  openCount: num,
  firstOpenedAt: dateOrNull,
  lastOpenedAt: dateOrNull,
  expiresAt: dateOrNull,
  revoked: bool,
  revokedAt: dateOrNull,
});

const cohorts = documentSchema({
  name: str,
  type: enumOf(['individual', 'organization']),
  organizationName: strOrNull,
  targetSize: numOrNull,
  questionnaireId: strOrNull,
  manuscriptEdition: enumOrNull(MANUSCRIPT_EDITIONS),
  status: enumOf(COHORT_STATUSES),
  notes: strOrNull,
});

const invitations = documentSchema({
  cohortId: strOrNull,
  code: str,
  email: strOrNull,
  displayName: strOrNull,
  country: strOrNull,
  preferredLanguage: strOrNull,
  occupationBackground: strOrNull,
  source: enumOrNull(['linkedin', 'email', 'org', 'direct']),
  status: enumOf(INVITATION_STATUSES),
  redeemedBySessionId: strOrNull,
  redeemedAt: dateOrNull,
  welcomeEmailSentAt: dateOrNull,
  readingLinkSentAt: dateOrNull,
  sentAt: dateOrNull,
  sendCount: numOrNull,
  lastError: strOrNull,
  firstOpenedAt: dateOrNull,
  revokedAt: dateOrNull,
  notes: strOrNull,
});

const emailTemplates = closed(
  {
    _id: str,
    subject: str,
    bodyText: str,
    bodyHtml: strOrNull,
    version: num,
    updatedBy: strOrNull,
    updatedAt: date,
    createdAt: date,
    schemaVersion: num,
  },
  ['_id'],
);

const questionnaires = documentSchema({
  title: str,
  version: str,
  status: enumOf(['active', 'archived']),
  purpose: strOrNull,
  instruction: strOrNull,
  scaleLegend: strOrNull,
  sections: arrayOf(closed({ key: str, title: str, description: strOrNull })),
  questions: arrayOf(
    closed({
      questionId: str,
      order: num,
      kind: enumOf(QUESTION_KINDS),
      prompt: str,
      options: { bsonType: ['array', 'null'], items: str },
      required: bool,
      section: strOrNull,
      label: strOrNull,
      scaleLegend: strOrNull,
      role: enumOrNull(QUESTION_ROLES),
    }),
  ),
});

const questionnaireResponses = documentSchema({
  questionnaireId: str,
  invitationId: strOrNull,
  sessionId: strOrNull,
  cohortId: strOrNull,
  answers: arrayOf(
    closed({
      questionId: str,
      text: strOrNull,
      rating: numOrNull,
      values: stringArray,
    }),
  ),
  reviewer: closedOrNull({
    name: strOrNull,
    completedOn: strOrNull,
    readingTime: strOrNull,
    quoteConsent: boolOrNull,
  }),
  readingFormat: enumOrNull(READING_FORMATS),
  completedAt: dateOrNull,
});

const feedback = documentSchema({
  sessionId: strOrNull,
  kind: enumOf(FEEDBACK_KINDS),
  category: enumOf(FEEDBACK_CATEGORIES),
  body: str,
  displayName: strOrNull,
  email: strOrNull,
  contactConsent: bool,
  passages: arrayOf(
    closed({
      unitId: str,
      componentIndex: numOrNull,
      excerpt: strOrNull,
      charStart: numOrNull,
      charEnd: numOrNull,
    }),
  ),
  releaseId: strOrNull,
  readingFormat: strOrNull,
  invitationId: strOrNull,
  cohortId: strOrNull,
  status: enumOf(FEEDBACK_STATUSES),
  adminNotes: strOrNull,
});

const donations = documentSchema({
  kind: enumOf(DONATION_KINDS),
  amountCents: num,
  currency: str,
  status: enumOf(DONATION_STATUSES),
  anonymous: bool,
  email: strOrNull,
  displayName: strOrNull,
  sessionId: strOrNull,
  nmi: NMI_RESULT,
  receiptNumber: strOrNull,
  digitalAccessGrantId: strOrNull,
  idempotencyKey: strOrNull,
  refunds: arrayOf(REFUND_ENTRY),
  failureReason: strOrNull,
  capturedAt: dateOrNull,
  refundedAt: dateOrNull,
});

const orders = documentSchema({
  orderNumber: strOrNull,
  type: enumOf(ORDER_TYPES),
  mode: enumOrNull(['purchase', 'reserve']),
  productSku: strOrNull,
  productId: strOrNull,
  quantity: num,
  amountCents: numOrNull,
  currency: strOrNull,
  email: strOrNull,
  customer: closedOrNull({ name: strOrNull, email: strOrNull }),
  shippingAddress: SHIPPING_ADDRESS,
  status: enumOf(ORDER_STATUSES),
  nmi: NMI_RESULT,
  receiptNumber: strOrNull,
  trackingNumber: strOrNull,
  idempotencyKey: strOrNull,
  sessionId: strOrNull,
  refunds: arrayOf(REFUND_ENTRY),
  notifiedAt: dateOrNull,
  paidAt: dateOrNull,
  shippedAt: dateOrNull,
  deliveredAt: dateOrNull,
  canceledAt: dateOrNull,
});

const products = documentSchema({
  sku: str,
  type: enumOf(PRODUCT_TYPES),
  name: strOrNull,
  title: strOrNull,
  edition: strOrNull,
  description: strOrNull,
  priceCents: numOrNull,
  currency: str,
  status: enumOf(PRODUCT_STATUSES),
  reservable: bool,
  purchasable: bool,
  shippingRequired: bool,
  active: bool,
});

const digitalAccessGrants = documentSchema({
  donationId: strOrNull,
  email: strOrNull,
  token: str,
  grantType: enumOf(['contribution', 'free_access']),
  revoked: bool,
  revokedAt: dateOrNull,
  lastAccessedAt: dateOrNull,
  accessCount: numOrNull,
});

const paymentTransactions = documentSchema({
  gateway: enumOf(['nmi']),
  gatewayTransactionId: str,
  kind: enumOf(['sale', 'refund', 'void', 'validate', 'query']),
  workflow: enumOf(['donation', 'purchase']),
  refCollection: enumOf([COLLECTIONS.DONATIONS, COLLECTIONS.ORDERS]),
  refId: str,
  amountCents: numOrNull,
  currency: strOrNull,
  responseCode: strOrNull,
  responseText: strOrNull,
  avsResult: strOrNull,
  cvvResult: strOrNull,
  cardBrand: strOrNull,
  last4: strOrNull,
  idempotencyKey: strOrNull,
});

const nmiWebhookEvents = documentSchema({
  gatewayEventId: str,
  eventType: str,
  signatureValid: bool,
  payload: openObjectOrNull,
  receivedAt: date,
  processedAt: dateOrNull,
  status: enumOf(['pending', 'processed', 'skipped', 'error']),
  error: strOrNull,
});

const familyMembers = documentSchema({
  email: str,
  displayName: strOrNull,
  consent: closedOrNull({
    becameFamilyAt: dateOrNull,
    copyVersion: strOrNull,
  }),
  arrivedFrom: enumOrNull(['S14_pathway', 'convergence_threshold']),
  sessionId: strOrNull,
  communicationPreference: enumOf(['updates', 'none']),
  status: enumOf(['active', 'withdrawn']),
  withdrawalToken: strOrNull,
  withdrawnAt: dateOrNull,
});

const adminUsers = documentSchema({
  email: str,
  displayName: strOrNull,
  passwordHash: str,
  mfa: closedOrNull({
    enabled: bool,
    totpSecretEnc: strOrNull,
    confirmedAt: dateOrNull,
  }),
  role: enumOf(ADMIN_ROLES),
  active: bool,
  lastLoginAt: dateOrNull,
  failedLoginCount: numOrNull,
  lockedUntil: dateOrNull,
  passwordChangedAt: dateOrNull,
  refreshTokenHash: strOrNull,
  refreshTokenExpiresAt: dateOrNull,
});

const contentVersions = documentSchema({
  targetCollection: enumOf([
    COLLECTIONS.MANUSCRIPT_UNITS,
    COLLECTIONS.SHARING_PROMPTS,
    COLLECTIONS.QUESTIONNAIRES,
    COLLECTIONS.PRODUCTS,
    COLLECTIONS.MANUSCRIPTS,
  ]),
  targetId: str,
  version: num,
  snapshot: openObjectOrNull,
  publishedBy: strOrNull,
  approvedBy: stringArray,
  changeReason: strOrNull,
  publishedAt: dateOrNull,
});

const auditLog = documentSchema({
  actorType: enumOf(AUDIT_ACTOR_TYPES),
  actorId: strOrNull,
  action: str,
  targetCollection: strOrNull,
  targetId: strOrNull,
  before: openObjectOrNull,
  after: openObjectOrNull,
  correlationId: strOrNull,
  at: date,
});

export const COLLECTION_VALIDATORS = Object.freeze({
  [COLLECTIONS.MANUSCRIPTS]: { $jsonSchema: manuscripts },
  [COLLECTIONS.MANUSCRIPT_UNITS]: { $jsonSchema: manuscriptUnits },
  [COLLECTIONS.RESONANCE_NODES]: { $jsonSchema: resonanceNodes },
  [COLLECTIONS.READING_SESSIONS]: { $jsonSchema: readingSessions },
  [COLLECTIONS.EVENTS]: { $jsonSchema: events },
  [COLLECTIONS.SHARING_PROMPTS]: { $jsonSchema: sharingPrompts },
  [COLLECTIONS.SHARE_TOKENS]: { $jsonSchema: shareTokens },
  [COLLECTIONS.COHORTS]: { $jsonSchema: cohorts },
  [COLLECTIONS.INVITATIONS]: { $jsonSchema: invitations },
  [COLLECTIONS.QUESTIONNAIRES]: { $jsonSchema: questionnaires },
  [COLLECTIONS.QUESTIONNAIRE_RESPONSES]: { $jsonSchema: questionnaireResponses },
  [COLLECTIONS.FEEDBACK]: { $jsonSchema: feedback },
  [COLLECTIONS.DONATIONS]: { $jsonSchema: donations },
  [COLLECTIONS.ORDERS]: { $jsonSchema: orders },
  [COLLECTIONS.PRODUCTS]: { $jsonSchema: products },
  [COLLECTIONS.DIGITAL_ACCESS_GRANTS]: { $jsonSchema: digitalAccessGrants },
  [COLLECTIONS.PAYMENT_TRANSACTIONS]: { $jsonSchema: paymentTransactions },
  [COLLECTIONS.NMI_WEBHOOK_EVENTS]: { $jsonSchema: nmiWebhookEvents },
  [COLLECTIONS.FAMILY_MEMBERS]: { $jsonSchema: familyMembers },
  [COLLECTIONS.ADMIN_USERS]: { $jsonSchema: adminUsers },
  [COLLECTIONS.CONTENT_VERSIONS]: { $jsonSchema: contentVersions },
  [COLLECTIONS.EMAIL_TEMPLATES]: { $jsonSchema: emailTemplates },
  [COLLECTIONS.AUDIT_LOG]: { $jsonSchema: auditLog },
});

export const VALIDATION_LEVEL = 'strict';
export const VALIDATION_ACTION = 'error';

export function declaredFieldNames(validators = COLLECTION_VALIDATORS) {
  const result = new Map();
  const walk = (node, sink) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, sink);
      return;
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) {
        sink.add(key);
        walk(node.properties[key], sink);
      }
    }
    if (node.items) walk(node.items, sink);
  };
  for (const [name, validator] of Object.entries(validators)) {
    const sink = new Set();
    walk(validator.$jsonSchema, sink);
    result.set(name, sink);
  }
  return result;
}

export function assertNoProhibitedFields(validators = COLLECTION_VALIDATORS) {
  const prohibited = new Set(PROHIBITED_FIELDS.map((field) => field.toLowerCase()));
  const offences = [];
  for (const [collectionName, fields] of declaredFieldNames(validators)) {
    for (const field of fields) {
      if (prohibited.has(field.toLowerCase())) {
        offences.push(`${collectionName}.${field}`);
      }
    }
  }
  if (offences.length > 0) {
    throw new Error(
      `Prohibited profiling fields declared in collection validators: ${offences.join(', ')}. ` +
        'These fields may not exist anywhere in the data model (BUILD_CONTRACT §5, master §9.5).',
    );
  }
}

export async function applyValidators(db, options = {}) {
  const { logger } = options;
  assertNoProhibitedFields();

  let applied = 0;
  const failures = [];

  for (const [collectionName, validator] of Object.entries(COLLECTION_VALIDATORS)) {
    const spec = {
      validator,
      validationLevel: VALIDATION_LEVEL,
      validationAction: VALIDATION_ACTION,
    };
    try {
      await db.command({ collMod: collectionName, ...spec });
      applied += 1;
    } catch (error) {
      if (error.codeName === 'NamespaceNotFound' || error.code === 26) {
        try {
          await db.createCollection(collectionName, spec);
          applied += 1;
          continue;
        } catch (createError) {
          if (createError.codeName === 'NamespaceExists' || createError.code === 48) {
            applied += 1;
            continue;
          }
          failures.push(`${collectionName}: ${createError.codeName ?? createError.message}`);
          continue;
        }
      }
      failures.push(`${collectionName}: ${error.codeName ?? error.message}`);
    }
  }

  if (logger) {
    logger.info({ applied, failures: failures.length }, 'collection validators applied');
    for (const failure of failures) logger.warn({ failure }, 'validator could not be applied');
  }
  return { applied, failures };
}
