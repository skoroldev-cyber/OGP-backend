export const COLLECTIONS = Object.freeze({
  MANUSCRIPTS: 'manuscripts',
  MANUSCRIPT_UNITS: 'manuscript_units',
  RESONANCE_NODES: 'resonance_nodes',
  READING_SESSIONS: 'reading_sessions',
  EVENTS: 'events',
  SHARING_PROMPTS: 'sharing_prompts',
  SHARE_TOKENS: 'share_tokens',
  COHORTS: 'cohorts',
  INVITATIONS: 'invitations',
  QUESTIONNAIRES: 'questionnaires',
  QUESTIONNAIRE_RESPONSES: 'questionnaire_responses',
  FEEDBACK: 'feedback',
  DONATIONS: 'donations',
  ORDERS: 'orders',
  PRODUCTS: 'products',
  DIGITAL_ACCESS_GRANTS: 'digital_access_grants',
  PAYMENT_TRANSACTIONS: 'payment_transactions',
  NMI_WEBHOOK_EVENTS: 'nmi_webhook_events',
  FAMILY_MEMBERS: 'family_members',
  ADMIN_USERS: 'admin_users',
  CONTENT_VERSIONS: 'content_versions',
  EMAIL_TEMPLATES: 'email_templates',
  AUDIT_LOG: 'audit_log',
});

export const COLLECTION_NAMES = Object.freeze(Object.values(COLLECTIONS));

export const APPEND_ONLY_COLLECTIONS = Object.freeze([
  COLLECTIONS.EVENTS,
  COLLECTIONS.AUDIT_LOG,
  COLLECTIONS.CONTENT_VERSIONS,
  COLLECTIONS.PAYMENT_TRANSACTIONS,
]);

export const PII_COLLECTIONS = Object.freeze([
  COLLECTIONS.INVITATIONS,
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.DIGITAL_ACCESS_GRANTS,
  COLLECTIONS.FAMILY_MEMBERS,
  COLLECTIONS.ADMIN_USERS,
  COLLECTIONS.FEEDBACK,
]);

export const SEVERABLE_SESSION_REFERENCES = Object.freeze([
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.FAMILY_MEMBERS,
  COLLECTIONS.QUESTIONNAIRE_RESPONSES,
  COLLECTIONS.FEEDBACK,
  COLLECTIONS.SHARE_TOKENS,
]);

export function createCollections(db) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('createCollections: a MongoDB Db handle is required.');
  }
  return Object.freeze({
    manuscripts: db.collection(COLLECTIONS.MANUSCRIPTS),
    manuscriptUnits: db.collection(COLLECTIONS.MANUSCRIPT_UNITS),
    resonanceNodes: db.collection(COLLECTIONS.RESONANCE_NODES),
    readingSessions: db.collection(COLLECTIONS.READING_SESSIONS),
    events: db.collection(COLLECTIONS.EVENTS),
    sharingPrompts: db.collection(COLLECTIONS.SHARING_PROMPTS),
    shareTokens: db.collection(COLLECTIONS.SHARE_TOKENS),
    cohorts: db.collection(COLLECTIONS.COHORTS),
    invitations: db.collection(COLLECTIONS.INVITATIONS),
    questionnaires: db.collection(COLLECTIONS.QUESTIONNAIRES),
    questionnaireResponses: db.collection(COLLECTIONS.QUESTIONNAIRE_RESPONSES),
    feedback: db.collection(COLLECTIONS.FEEDBACK),
    donations: db.collection(COLLECTIONS.DONATIONS),
    orders: db.collection(COLLECTIONS.ORDERS),
    products: db.collection(COLLECTIONS.PRODUCTS),
    digitalAccessGrants: db.collection(COLLECTIONS.DIGITAL_ACCESS_GRANTS),
    paymentTransactions: db.collection(COLLECTIONS.PAYMENT_TRANSACTIONS),
    nmiWebhookEvents: db.collection(COLLECTIONS.NMI_WEBHOOK_EVENTS),
    familyMembers: db.collection(COLLECTIONS.FAMILY_MEMBERS),
    adminUsers: db.collection(COLLECTIONS.ADMIN_USERS),
    contentVersions: db.collection(COLLECTIONS.CONTENT_VERSIONS),
    emailTemplates: db.collection(COLLECTIONS.EMAIL_TEMPLATES),
    auditLog: db.collection(COLLECTIONS.AUDIT_LOG),
  });
}

export function collection(db, name) {
  if (!COLLECTION_NAMES.includes(name)) {
    throw new TypeError(`collection: "${name}" is not a registered collection.`);
  }
  return db.collection(name);
}

export function creationStamps(schemaVersion, now = new Date()) {
  return { createdAt: now, updatedAt: now, schemaVersion };
}

export function updateStamps(now = new Date()) {
  return { updatedAt: now };
}
