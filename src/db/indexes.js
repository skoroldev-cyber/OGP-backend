/**
 * Index definitions for every collection.
 *
 * Rule (§9.8): every hot-path query is index-covered. Uniqueness constraints here are the
 * last line of defence for the invariants the services enforce — one canonical public
 * edition, one session per token hash, one gateway transaction per payment record, one
 * redemption per invitation code.
 *
 * Optional-field uniqueness uses `partialFilterExpression` rather than `sparse`, so a
 * document that simply omits the field never collides with another that also omits it.
 */

import { COLLECTIONS } from './collections.js';

const existsString = (field) => ({ [field]: { $type: 'string' } });

/**
 * Declarative index specification, keyed by collection name.
 * Each entry is `{ name, key, options? }` and is applied idempotently.
 */
export const INDEX_SPECS = Object.freeze({
  [COLLECTIONS.MANUSCRIPTS]: Object.freeze([
    { name: 'manuscripts_branch_status', key: { branch: 1, status: 1 } },
    { name: 'manuscripts_edition', key: { edition: 1 } },
    {
      // Exactly one canonical edition per branch.
      name: 'manuscripts_canonical_unique',
      key: { branch: 1 },
      options: { unique: true, partialFilterExpression: { isCanonical: true } },
    },
  ]),

  [COLLECTIONS.MANUSCRIPT_UNITS]: Object.freeze([
    {
      name: 'manuscript_units_sequence_unique',
      key: { manuscriptId: 1, sequence_index: 1 },
      options: { unique: true },
    },
    {
      name: 'manuscript_units_unit_unique',
      key: { unitId: 1, manuscriptId: 1 },
      options: { unique: true },
    },
    { name: 'manuscript_units_opening_arc', key: { manuscriptId: 1, is_opening_arc: 1, sequence_index: 1 } },
    { name: 'manuscript_units_status', key: { status: 1 } },
    { name: 'manuscript_units_no_share_zone', key: { is_no_share_zone: 1 } },
    { name: 'manuscript_units_parent', key: { parent_unit_id: 1 } },
  ]),

  [COLLECTIONS.RESONANCE_NODES]: Object.freeze([
    { name: 'resonance_nodes_node_unique', key: { node_id: 1 }, options: { unique: true } },
    { name: 'resonance_nodes_unit', key: { manuscript_unit_id: 1, node_type: 1 } },
    { name: 'resonance_nodes_validated', key: { node_type: 1, 'qa_status.validated': 1 } },
  ]),

  [COLLECTIONS.READING_SESSIONS]: Object.freeze([
    { name: 'reading_sessions_token_unique', key: { tokenHash: 1 }, options: { unique: true } },
    { name: 'reading_sessions_cohort', key: { cohortId: 1 } },
    {
      // TTL: the document disappears at `expiresAt` (§9.5 retention).
      name: 'reading_sessions_ttl',
      key: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
  ]),

  [COLLECTIONS.EVENTS]: Object.freeze([
    { name: 'events_session_received', key: { sessionId: 1, receivedAt: 1 } },
    { name: 'events_name_received', key: { name: 1, receivedAt: 1 } },
  ]),

  [COLLECTIONS.SHARING_PROMPTS]: Object.freeze([
    { name: 'sharing_prompts_prompt_unique', key: { prompt_id: 1 }, options: { unique: true } },
    { name: 'sharing_prompts_active', key: { active: 1, prompt_type: 1 } },
  ]),

  [COLLECTIONS.SHARE_TOKENS]: Object.freeze([
    { name: 'share_tokens_token_unique', key: { token: 1 }, options: { unique: true } },
    { name: 'share_tokens_creator', key: { createdBySessionId: 1, createdAt: -1 } },
    { name: 'share_tokens_revoked', key: { revoked: 1 } },
  ]),

  [COLLECTIONS.COHORTS]: Object.freeze([
    { name: 'cohorts_status', key: { status: 1 } },
    { name: 'cohorts_name_unique', key: { name: 1 }, options: { unique: true } },
  ]),

  [COLLECTIONS.INVITATIONS]: Object.freeze([
    { name: 'invitations_code_unique', key: { code: 1 }, options: { unique: true } },
    { name: 'invitations_cohort_status', key: { cohortId: 1, status: 1 } },
    // The dashboard's default ordering for the invitation status list (§10.7.2).
    { name: 'invitations_created', key: { createdAt: -1 } },
    {
      name: 'invitations_email',
      key: { email: 1 },
      options: { partialFilterExpression: existsString('email') },
    },
    {
      name: 'invitations_redeemed_session',
      key: { redeemedBySessionId: 1 },
      options: { partialFilterExpression: existsString('redeemedBySessionId') },
    },
  ]),

  [COLLECTIONS.QUESTIONNAIRES]: Object.freeze([
    { name: 'questionnaires_status', key: { status: 1, version: -1 } },
  ]),

  [COLLECTIONS.QUESTIONNAIRE_RESPONSES]: Object.freeze([
    { name: 'questionnaire_responses_questionnaire', key: { questionnaireId: 1, completedAt: -1 } },
    { name: 'questionnaire_responses_cohort', key: { cohortId: 1, completedAt: -1 } },
    // The review screen's default view is every response, newest first, with no filter at
    // all. The compound indexes above cannot serve that sort.
    { name: 'questionnaire_responses_completed', key: { completedAt: -1 } },
    { name: 'questionnaire_responses_format', key: { readingFormat: 1, completedAt: -1 } },
    {
      name: 'questionnaire_responses_invitation_unique',
      key: { questionnaireId: 1, invitationId: 1 },
      options: { unique: true, partialFilterExpression: existsString('invitationId') },
    },
  ]),

  /**
   * The review queue is read four ways — by triage state, by category, by cohort, and by
   * the passage a reader marked — so each has its own compound index ending in `createdAt`,
   * which is also the sort. `passages.unitId` is multikey: one submission may mark several
   * passages and must be findable under each of them.
   */
  [COLLECTIONS.FEEDBACK]: Object.freeze([
    { name: 'feedback_status_created', key: { status: 1, createdAt: -1 } },
    { name: 'feedback_category_created', key: { category: 1, createdAt: -1 } },
    { name: 'feedback_cohort_created', key: { cohortId: 1, createdAt: -1 } },
    { name: 'feedback_passage_unit', key: { 'passages.unitId': 1, createdAt: -1 } },
    {
      // `GET /feedback/mine`. Partial, because severance nulls the reference and a null
      // session is not something anything ever looks up.
      name: 'feedback_session_created',
      key: { sessionId: 1, createdAt: -1 },
      options: { partialFilterExpression: existsString('sessionId') },
    },
  ]),

  [COLLECTIONS.DONATIONS]: Object.freeze([
    {
      name: 'donations_nmi_transaction_unique',
      key: { 'nmi.transactionId': 1 },
      options: { unique: true, partialFilterExpression: existsString('nmi.transactionId') },
    },
    {
      name: 'donations_receipt_unique',
      key: { receiptNumber: 1 },
      options: { unique: true, partialFilterExpression: existsString('receiptNumber') },
    },
    {
      name: 'donations_idempotency_unique',
      key: { idempotencyKey: 1 },
      options: { unique: true, partialFilterExpression: existsString('idempotencyKey') },
    },
    { name: 'donations_status_created', key: { status: 1, createdAt: -1 } },
  ]),

  [COLLECTIONS.ORDERS]: Object.freeze([
    {
      name: 'orders_number_unique',
      key: { orderNumber: 1 },
      options: { unique: true, partialFilterExpression: existsString('orderNumber') },
    },
    {
      name: 'orders_nmi_transaction_unique',
      key: { 'nmi.transactionId': 1 },
      options: { unique: true, partialFilterExpression: existsString('nmi.transactionId') },
    },
    {
      name: 'orders_idempotency_unique',
      key: { idempotencyKey: 1 },
      options: { unique: true, partialFilterExpression: existsString('idempotencyKey') },
    },
    { name: 'orders_status_created', key: { status: 1, createdAt: -1 } },
    { name: 'orders_email', key: { email: 1, createdAt: -1 } },
  ]),

  [COLLECTIONS.PRODUCTS]: Object.freeze([
    { name: 'products_sku_unique', key: { sku: 1 }, options: { unique: true } },
    { name: 'products_status_active', key: { status: 1, active: 1 } },
  ]),

  [COLLECTIONS.DIGITAL_ACCESS_GRANTS]: Object.freeze([
    { name: 'digital_access_grants_token_unique', key: { token: 1 }, options: { unique: true } },
    { name: 'digital_access_grants_email', key: { email: 1, createdAt: -1 } },
    {
      name: 'digital_access_grants_donation',
      key: { donationId: 1 },
      options: { partialFilterExpression: existsString('donationId') },
    },
  ]),

  [COLLECTIONS.PAYMENT_TRANSACTIONS]: Object.freeze([
    {
      name: 'payment_transactions_gateway_unique',
      key: { gatewayTransactionId: 1, kind: 1 },
      options: { unique: true },
    },
    { name: 'payment_transactions_ref', key: { refCollection: 1, refId: 1, createdAt: -1 } },
    { name: 'payment_transactions_created', key: { createdAt: -1 } },
  ]),

  [COLLECTIONS.NMI_WEBHOOK_EVENTS]: Object.freeze([
    {
      name: 'nmi_webhook_events_gateway_event_unique',
      key: { gatewayEventId: 1, eventType: 1 },
      options: { unique: true },
    },
    { name: 'nmi_webhook_events_status', key: { status: 1, receivedAt: -1 } },
  ]),

  [COLLECTIONS.FAMILY_MEMBERS]: Object.freeze([
    { name: 'family_members_email_unique', key: { email: 1 }, options: { unique: true } },
    { name: 'family_members_status', key: { status: 1, createdAt: -1 } },
  ]),

  [COLLECTIONS.ADMIN_USERS]: Object.freeze([
    { name: 'admin_users_email_unique', key: { email: 1 }, options: { unique: true } },
    { name: 'admin_users_role_active', key: { role: 1, active: 1 } },
  ]),

  [COLLECTIONS.CONTENT_VERSIONS]: Object.freeze([
    {
      name: 'content_versions_target_version_unique',
      key: { targetCollection: 1, targetId: 1, version: -1 },
      options: { unique: true },
    },
    { name: 'content_versions_published', key: { publishedAt: -1 } },
  ]),

  /**
   * `_id` is the template key, so lookup by key is already covered. The only other query is
   * the dashboard listing, ordered by when each template was last touched.
   */
  [COLLECTIONS.EMAIL_TEMPLATES]: Object.freeze([
    { name: 'email_templates_updated', key: { updatedAt: -1 } },
  ]),

  [COLLECTIONS.AUDIT_LOG]: Object.freeze([
    { name: 'audit_log_at', key: { at: -1 } },
    { name: 'audit_log_target', key: { targetCollection: 1, targetId: 1, at: -1 } },
    { name: 'audit_log_actor', key: { actorId: 1, at: -1 } },
    { name: 'audit_log_action', key: { action: 1, at: -1 } },
  ]),
});

/** Total number of declared indexes. Useful as a smoke assertion in tests. */
export const INDEX_COUNT = Object.values(INDEX_SPECS).reduce(
  (total, specs) => total + specs.length,
  0,
);

/**
 * Create every declared index. Idempotent: MongoDB ignores an identical existing index and
 * `IndexOptionsConflict` / `IndexKeySpecsConflict` are surfaced rather than swallowed, so a
 * drifted definition is visible instead of silently ignored.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @param {{ logger?: { info: Function, warn: Function } }} [options] Optional logger.
 * @returns {Promise<{ created: number, collections: number, conflicts: string[] }>} Summary.
 */
export async function ensureIndexes(db, options = {}) {
  const { logger } = options;
  let created = 0;
  const conflicts = [];
  const collectionNames = Object.keys(INDEX_SPECS);

  for (const collectionName of collectionNames) {
    const specs = INDEX_SPECS[collectionName];
    const models = specs.map((spec) => ({
      key: spec.key,
      name: spec.name,
      ...(spec.options ?? {}),
    }));
    try {
      await db.collection(collectionName).createIndexes(models);
      created += models.length;
    } catch {
      // Apply one at a time so a single drifted index does not hide the rest.
      for (const model of models) {
        try {
          await db.collection(collectionName).createIndexes([model]);
          created += 1;
        } catch (single) {
          conflicts.push(`${collectionName}.${model.name}: ${single.codeName ?? single.message}`);
          if (logger) {
            logger.warn(
              { collection: collectionName, index: model.name, reason: single.codeName },
              'index could not be applied',
            );
          }
        }
      }
    }
  }

  if (logger) {
    logger.info(
      { collections: collectionNames.length, created, conflicts: conflicts.length },
      'indexes ensured',
    );
  }
  return { created, collections: collectionNames.length, conflicts };
}

/**
 * Report indexes present in the database that this file does not declare. Drift detection
 * for the deployment checklist; never destructive.
 *
 * @param {import('mongodb').Db} db An open database handle.
 * @returns {Promise<Array<{ collection: string, index: string }>>} Undeclared indexes.
 */
export async function findUndeclaredIndexes(db) {
  const undeclared = [];
  for (const [collectionName, specs] of Object.entries(INDEX_SPECS)) {
    const declared = new Set(['_id_', ...specs.map((spec) => spec.name)]);
    let existing;
    try {
      existing = await db.collection(collectionName).indexes();
    } catch {
      continue;
    }
    for (const index of existing) {
      if (!declared.has(index.name)) {
        undeclared.push({ collection: collectionName, index: index.name });
      }
    }
  }
  return undeclared;
}
