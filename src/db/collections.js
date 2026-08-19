/**
 * Collection registry.
 *
 * Twenty-three collections, snake_case plural: the twenty-one of BUILD_CONTRACT §5 plus
 * `feedback` and `email_templates`.
 *
 * `email_templates` holds the editable copy of the two Founding Reader messages (§10.7.2,
 * "send welcome email, issue private reading link"). It is the one collection whose `_id`
 * is a stable key rather than a ULID: a template is addressed by name in a route and in a
 * send request, and a generated id would put an indirection between the founder's edit and
 * the message that goes out. The set of keys is closed (`EMAIL_TEMPLATE_KEYS`), so this is
 * not a general message composer — §10.6.4 rules out email campaign tooling.
 *
 * `feedback` is free-form reader feedback, a different record from a
 * `questionnaire_responses` row: it is unsolicited rather than instrument-driven, it may be
 * anchored to passages the reader marked (§3.4.2, "content must be addressable, enabling
 * passage-linked feedback"), and it carries an optional contact detail the instrument never
 * collects. Storing it in the responses collection would have meant widening the research
 * record to hold contact details, which is precisely the join §9.2.7 keeps closed.
 *
 * Nothing outside this file may name a collection with a string literal: a typo would
 * silently create a new, unvalidated, unindexed collection.
 *
 * Every document carries `createdAt`, `updatedAt` and `schemaVersion`; `_id` is a
 * server-generated ULID string.
 */

/** Canonical collection names, keyed by screaming-snake symbol. */
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

/** Every collection name, in registry order. */
export const COLLECTION_NAMES = Object.freeze(Object.values(COLLECTIONS));

/**
 * Collections that are append-only. No update or delete route exists for these; the
 * services must never expose one.
 */
export const APPEND_ONLY_COLLECTIONS = Object.freeze([
  COLLECTIONS.EVENTS,
  COLLECTIONS.AUDIT_LOG,
  COLLECTIONS.CONTENT_VERSIONS,
  COLLECTIONS.PAYMENT_TRANSACTIONS,
]);

/**
 * Collections that hold personally identifying information. They join the anonymous
 * reading side only through a severable `sessionId` (§9.5.3).
 */
export const PII_COLLECTIONS = Object.freeze([
  COLLECTIONS.INVITATIONS,
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.DIGITAL_ACCESS_GRANTS,
  COLLECTIONS.FAMILY_MEMBERS,
  COLLECTIONS.ADMIN_USERS,
  // `feedback` may hold a name and — only with explicit contact consent — an email address.
  // Listing it here puts it behind the same wall: no age band, no content layer, no reading
  // trail may ever be declared beside those details (§9.2.7).
  COLLECTIONS.FEEDBACK,
]);

/**
 * Collections carrying a severable `sessionId`. `DELETE /sessions/current` nulls the
 * reference here rather than deleting the record.
 */
export const SEVERABLE_SESSION_REFERENCES = Object.freeze([
  COLLECTIONS.DONATIONS,
  COLLECTIONS.ORDERS,
  COLLECTIONS.FAMILY_MEMBERS,
  COLLECTIONS.QUESTIONNAIRE_RESPONSES,
  COLLECTIONS.FEEDBACK,
  COLLECTIONS.SHARE_TOKENS,
]);

/**
 * Bind every collection to a database handle.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @returns {Readonly<Record<string, import('mongodb').Collection>>} Frozen accessors,
 *          keyed by camelCase collection name.
 */
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

/**
 * Single-collection accessor, for call sites that need exactly one handle.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {string} name A value from {@link COLLECTIONS}.
 * @returns {import('mongodb').Collection} The collection handle.
 */
export function collection(db, name) {
  if (!COLLECTION_NAMES.includes(name)) {
    throw new TypeError(`collection: "${name}" is not a registered collection.`);
  }
  return db.collection(name);
}

/**
 * The audit trail of stamps every write applies.
 *
 * @param {number} schemaVersion Current document schema version.
 * @param {Date} [now] Timestamp override for tests.
 * @returns {{ createdAt: Date, updatedAt: Date, schemaVersion: number }} Stamp fields.
 */
export function creationStamps(schemaVersion, now = new Date()) {
  return { createdAt: now, updatedAt: now, schemaVersion };
}

/**
 * @param {Date} [now] Timestamp override for tests.
 * @returns {{ updatedAt: Date }} The update stamp.
 */
export function updateStamps(now = new Date()) {
  return { updatedAt: now };
}
