/**
 * Admin routes.
 *
 * Thin adapters, one rule each. Everything of consequence happens in the services; what
 * this file decides is *who may ask*.
 *
 * `requireAdmin([...roles])` guards every route except the two that mint a session, and
 * `requireAdmin()` with no list means "any active administrator with confirmed MFA" — the
 * plugin re-reads the account on every request, so a deactivated admin or a changed role
 * cannot ride a token that was valid a minute ago.
 *
 * Role assignment follows §9.2.10 and §10.8.1:
 *
 *   founder            everything
 *   architect          full technical administration
 *   editor             authors and publishes content
 *   reviewer           approves content, validates resonance, reads responses
 *   beta_coordinator   cohorts, invitations, questionnaires
 *   finance            the two commerce ledgers and refunds
 *
 * Two-person control is not expressible as a role list — an editor may hold both `editor`
 * and the authorship of the unit in front of them — so `approve` and `publish` additionally
 * compare identities inside the content service.
 */

import { createAdminAuthService } from './auth.js';
import { createAdminBetaService } from './beta.js';
import { createAdminCommerceService } from './commerce.js';
import { createAdminContentService } from './content.js';
import { createAdminFeedbackService } from './feedback.js';
import { createAdminInvitationsService } from './invitations.js';
import { createAdminMetricsService } from './metrics.js';
import { createAdminOpsService } from './ops.js';
import { createAdminResonanceService } from './resonance.js';
import { createAdminSharingService } from './sharing.js';
import { createAdminTemplatesService } from './templates.js';
import {
  adminErrorResponses,
  adminHeaders,
  auditQuery,
  auditResponse,
  cohortMetricsResponse,
  cohortResponse,
  cohortSummaryResponse,
  cohortsQuery,
  cohortsResponse,
  createCohortBody,
  createInvitationBody,
  createManuscriptBody,
  createQuestionnaireBody,
  createResonanceNodeBody,
  createSharingPromptBody,
  createUnitBody,
  csvResponse,
  emptyResponse,
  eventsMetricQuery,
  eventsMetricResponse,
  feedbackExportQuery,
  feedbackListResponse,
  feedbackQuery,
  feedbackResponse,
  feedbackSummaryResponse,
  fulfillBody,
  funnelQuery,
  funnelResponse,
  healthDetailResponse,
  idParams,
  importBody,
  importResponse,
  invitationResponse,
  invitationsQuery,
  invitationsResponse,
  loginBody,
  manuscriptResponse,
  manuscriptsQuery,
  manuscriptsResponse,
  orderResponse,
  ordersQuery,
  ordersResponse,
  donationsQuery,
  donationsResponse,
  previewTemplateBody,
  publishBody,
  publishResponse,
  questionnaireResponseDetailResponse,
  questionnaireResponseEnvelope,
  questionnaireResponseSummaryQuery,
  questionnaireResponseSummaryResponse,
  questionnaireResponsesExportQuery,
  questionnaireResponsesQuery,
  questionnaireResponsesResponse,
  questionnairesQuery,
  questionnairesResponse,
  refreshBody,
  refundBody,
  refundResponse,
  resendInvitationBody,
  resonanceNodeResponse,
  resonanceNodesQuery,
  resonanceNodesResponse,
  revokeInvitationBody,
  reviewActionBody,
  sendInvitationsBody,
  sendInvitationsResponse,
  sendWelcomeResponse,
  sessionResponse,
  sharingPromptResponse,
  sharingPromptsQuery,
  sharingPromptsResponse,
  templateKeyParams,
  templatePreviewResponse,
  templateResponse,
  templatesResponse,
  unitResponse,
  unitsQuery,
  unitsResponse,
  updateCohortBody,
  updateFeedbackBody,
  updateInvitationBody,
  updateManuscriptBody,
  updateQuestionnaireBody,
  updateResonanceNodeBody,
  updateSharingPromptBody,
  updateTemplateBody,
  updateUnitBody,
  validateResonanceNodeBody,
  versionsResponse,
} from './schemas.js';

/** Role sets, named once so a route can never drift from its neighbour by a typo. */
const ROLES = Object.freeze({
  ANY: [],
  CONTENT_WRITE: ['founder', 'architect', 'editor'],
  CONTENT_APPROVE: ['founder', 'architect', 'reviewer'],
  CONTENT_PUBLISH: ['founder', 'architect', 'editor'],
  RESONANCE_WRITE: ['founder', 'architect', 'editor'],
  RESONANCE_VALIDATE: ['founder', 'architect', 'reviewer'],
  SHARING_WRITE: ['founder', 'architect', 'editor'],
  SHARING_ACTIVATE: ['founder', 'architect'],
  BETA: ['founder', 'architect', 'beta_coordinator'],
  FEEDBACK_READ: ['founder', 'architect', 'beta_coordinator', 'reviewer'],
  // Triage and export are narrower than reading: a reviewer reads the queue, a coordinator
  // works it. The export additionally moves contact details off the platform.
  FEEDBACK_TRIAGE: ['founder', 'architect', 'beta_coordinator'],
  COMMERCE_READ: ['founder', 'architect', 'finance'],
  COMMERCE_REFUND: ['founder', 'finance'],
  COMMERCE_FULFILL: ['founder', 'architect', 'finance'],
  OPS: ['founder', 'architect'],
});

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const config = opts.config ?? app.config;
  const logger = app.log;
  const db = app.db;

  const auth = createAdminAuthService({ db, config, logger });
  const content = createAdminContentService({ db, config, logger });
  const resonance = createAdminResonanceService({ db, logger });
  const sharing = createAdminSharingService({ db, logger });
  const beta = createAdminBetaService({ db, config, logger });
  const templates = createAdminTemplatesService({ db, config, logger });
  // The templates service is handed over rather than left to be constructed a second time:
  // seeding is `$setOnInsert` and safe either way, but one instance means one place where a
  // founder's stored copy is read on the path that actually mails it.
  const invitations = createAdminInvitationsService({ db, config, logger, templates });
  const feedback = createAdminFeedbackService({ db });
  const commerce = createAdminCommerceService({ db, config, logger });
  const metrics = createAdminMetricsService({ db, beta });
  const ops = createAdminOpsService({
    db,
    config,
    logger,
    mongoReady: app.mongoReady?.bind(app) ?? null,
  });

  /** Audit context for every mutation. */
  const context = (request) => ({ correlationId: request.id });

  /**
   * §10.10.1 requires the admin namespace to carry its own rate limits. This applies the
   * general budget to every route below that does not name one, rather than repeating a
   * `config` block sixty times — a list that long is maintained by nobody, and the route that
   * gets forgotten is the one nobody notices is unprotected.
   *
   * Declaring a limit on the route still wins: `adminLogin` keeps its 5-per-15-minutes with
   * backoff, and the two routes that send mail keep the much tighter `adminBulkSend`.
   *
   * This hook is scoped to this encapsulated plugin, so it cannot reach a reader-facing route.
   */
  app.addHook('onRoute', (route) => {
    if (route.config?.rateLimit) return;
    route.config = { ...(route.config ?? {}), rateLimit: app.rateLimits.adminGeneral };
  });

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/admin/auth/login',
    {
      config: { rateLimit: app.rateLimits.adminLogin },
      schema: {
        body: loginBody,
        response: { 200: sessionResponse, ...adminErrorResponses },
      },
    },
    async (request) => auth.login(request.body, context(request)),
  );

  app.post(
    '/admin/auth/refresh',
    {
      config: { rateLimit: app.rateLimits.adminLogin },
      schema: {
        body: refreshBody,
        response: { 200: sessionResponse, ...adminErrorResponses },
      },
    },
    async (request) => auth.refresh(request.body, context(request)),
  );

  app.post(
    '/admin/auth/logout',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        response: { 204: emptyResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      await auth.logout(request.admin, context(request));
      return reply.code(204).send();
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Content — manuscripts                                                   */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/manuscripts',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: manuscriptsQuery,
        response: { 200: manuscriptsResponse, ...adminErrorResponses },
      },
    },
    async (request) => content.listManuscripts(request.query),
  );

  app.post(
    '/admin/manuscripts',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_WRITE),
      schema: {
        headers: adminHeaders,
        body: createManuscriptBody,
        response: { 201: manuscriptResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await content.createManuscript(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/admin/manuscripts/:id',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_WRITE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateManuscriptBody,
        response: { 200: manuscriptResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      content.updateManuscript(request.admin, request.params.id, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Content — units                                                         */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/units',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: unitsQuery,
        response: { 200: unitsResponse, ...adminErrorResponses },
      },
    },
    async (request) => content.listUnits(request.query),
  );

  app.get(
    '/admin/units/:id',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: unitResponse, ...adminErrorResponses },
      },
    },
    async (request) => content.getUnit(request.params.id),
  );

  app.post(
    '/admin/units',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_WRITE),
      schema: {
        headers: adminHeaders,
        body: createUnitBody,
        response: { 201: unitResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await content.createUnit(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  /**
   * The canonical lock lives behind this route: a write touching `canonicalText` on a
   * published `opening_arc` unit is refused with `423` and recorded as
   * `canonical_lock.rejected`.
   */
  app.patch(
    '/admin/units/:id',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_WRITE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateUnitBody,
        response: { 200: unitResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      content.updateUnit(request.admin, request.params.id, request.body, context(request)),
  );

  app.post(
    '/admin/units/:id/submit-review',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_WRITE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: reviewActionBody,
        response: { 200: unitResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      content.submitForReview(request.admin, request.params.id, request.body ?? {}, context(request)),
  );

  app.post(
    '/admin/units/:id/approve',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_APPROVE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: reviewActionBody,
        response: { 200: unitResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      content.approveUnit(request.admin, request.params.id, request.body ?? {}, context(request)),
  );

  app.post(
    '/admin/units/:id/publish',
    {
      preHandler: app.requireAdmin(ROLES.CONTENT_PUBLISH),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: publishBody,
        response: { 200: publishResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      content.publishUnit(request.admin, request.params.id, request.body ?? {}, context(request)),
  );

  app.get(
    '/admin/units/:id/versions',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: versionsResponse, ...adminErrorResponses },
      },
    },
    async (request) => content.listVersions(request.params.id),
  );

  /* ---------------------------------------------------------------------- */
  /* Resonance                                                               */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/resonance-nodes',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: resonanceNodesQuery,
        response: { 200: resonanceNodesResponse, ...adminErrorResponses },
      },
    },
    async (request) => resonance.list(request.query),
  );

  app.post(
    '/admin/resonance-nodes',
    {
      preHandler: app.requireAdmin(ROLES.RESONANCE_WRITE),
      schema: {
        headers: adminHeaders,
        body: createResonanceNodeBody,
        response: { 201: resonanceNodeResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await resonance.create(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/admin/resonance-nodes/:id',
    {
      preHandler: app.requireAdmin(ROLES.RESONANCE_WRITE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateResonanceNodeBody,
        response: { 200: resonanceNodeResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      resonance.update(request.admin, request.params.id, request.body, context(request)),
  );

  app.post(
    '/admin/resonance-nodes/:id/validate',
    {
      preHandler: app.requireAdmin(ROLES.RESONANCE_VALIDATE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: validateResonanceNodeBody,
        response: { 200: resonanceNodeResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      resonance.validate(request.admin, request.params.id, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Sharing prompts                                                         */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/sharing-prompts',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: sharingPromptsQuery,
        response: { 200: sharingPromptsResponse, ...adminErrorResponses },
      },
    },
    async (request) => sharing.list(request.query),
  );

  app.post(
    '/admin/sharing-prompts',
    {
      preHandler: app.requireAdmin(ROLES.SHARING_WRITE),
      schema: {
        headers: adminHeaders,
        body: createSharingPromptBody,
        response: { 201: sharingPromptResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await sharing.create(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  /**
   * Activation is folded into the update so review state and `active` are decided in one
   * transaction: a prompt can never be activated by a request that also changed its text.
   */
  app.patch(
    '/admin/sharing-prompts/:id',
    {
      preHandler: app.requireAdmin(ROLES.SHARING_ACTIVATE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateSharingPromptBody,
        response: { 200: sharingPromptResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      sharing.update(request.admin, request.params.id, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Beta                                                                    */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/cohorts',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: cohortsQuery,
        response: { 200: cohortsResponse, ...adminErrorResponses },
      },
    },
    async (request) => beta.listCohorts(request.query),
  );

  app.post(
    '/admin/cohorts',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        body: createCohortBody,
        response: { 201: cohortResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await beta.createCohort(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/admin/cohorts/:id',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateCohortBody,
        response: { 200: cohortResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      beta.updateCohort(request.admin, request.params.id, request.body, context(request)),
  );

  app.get(
    '/admin/cohorts/:id/summary',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: cohortSummaryResponse, ...adminErrorResponses },
      },
    },
    async (request) => beta.cohortSummary(request.params.id),
  );

  app.get(
    '/admin/invitations',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        querystring: invitationsQuery,
        response: { 200: invitationsResponse, ...adminErrorResponses },
      },
    },
    async (request) => beta.listInvitations(request.query),
  );

  app.post(
    '/admin/invitations',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        body: createInvitationBody,
        response: { 201: invitationResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await beta.createInvitation(request.admin, request.body, context(request));
      reply.code(201);
      return result;
    },
  );

  /**
   * Bulk delivery — one message per address, addressed individually, never a shared
   * envelope: a Founding Reader must not learn who else is reading (§9.2.7).
   *
   * A `200` here does not mean every address was written to. Partial failure is the normal
   * case and comes back as a row per address; the only things that throw are a refused
   * cohort and a prohibited term in the coordinator's added line, both of which are one
   * decision about the whole batch rather than a fact about one mailbox.
   */
  app.post(
    '/admin/invitations/send',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      // The tight budget, not the general one: this is the request whose effect leaves the
      // building. It counts presses, not addresses — one call carrying two hundred
      // invitations costs one — so it bounds the double-submitted batch without bounding how
      // many Founding Readers a coordinator may write to. Mail cannot be recalled.
      config: { rateLimit: app.rateLimits.adminBulkSend },
      schema: {
        headers: adminHeaders,
        body: sendInvitationsBody,
        response: { 200: sendInvitationsResponse, ...adminErrorResponses },
      },
    },
    async (request) => invitations.sendBulk(request.admin, request.body, context(request)),
  );

  app.patch(
    '/admin/invitations/:id',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateInvitationBody,
        response: { 200: invitationResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      beta.updateInvitation(request.admin, request.params.id, request.body, context(request)),
  );

  /**
   * The deliberate, named, one-at-a-time repeat. It exists so that a bulk send never has to
   * become a reminder sequence: a second pass over a list skips whoever already holds a
   * link, and this route is the audited way to write to one of them again on purpose.
   */
  app.post(
    '/admin/invitations/:id/resend',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      // Shares the mail budget with the bulk route, and deliberately so: chasing a list one
      // address at a time is the same act as sending to it, and a limit either could sidestep
      // by using the other would not be a limit.
      config: { rateLimit: app.rateLimits.adminBulkSend },
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: resendInvitationBody,
        response: { 200: sendWelcomeResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      invitations.resend(request.admin, request.params.id, request.body ?? {}, context(request)),
  );

  /**
   * Withdrawal is recorded, never deleted: a participant's place in the funnel is study data,
   * and erasing it would falsify the record of who was approached (§10.7.2).
   */
  app.post(
    '/admin/invitations/:id/revoke',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: revokeInvitationBody,
        response: { 200: invitationResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      invitations.revoke(request.admin, request.params.id, request.body ?? {}, context(request)),
  );

  app.post(
    '/admin/invitations/:id/send-welcome',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      config: { rateLimit: app.rateLimits.adminBulkSend },
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: sendWelcomeResponse, ...adminErrorResponses },
      },
    },
    async (request) => beta.sendWelcome(request.admin, request.params.id, context(request)),
  );

  app.post(
    '/admin/beta/import',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        body: importBody,
        response: { 200: importResponse, ...adminErrorResponses },
      },
    },
    async (request) => beta.importInvitations(request.admin, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Beta — message templates                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The set is closed and there is no `POST`: §10.6.4 rules out email campaign tooling, and
   * a route that could create a new message type with a recipient list is exactly that. Copy
   * can be rewritten; a third message cannot be invented from the dashboard.
   *
   * Every one of these is linted against `content/rules.json` inside the service, which
   * refuses a prohibited term with a `422` naming it. The lint is not repeated here — a
   * second copy of it would be a second thing to keep in step with the rules file.
   */
  app.get(
    '/admin/templates',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        response: { 200: templatesResponse, ...adminErrorResponses },
      },
    },
    async () => templates.list(),
  );

  app.get(
    '/admin/templates/:key',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: templateKeyParams,
        response: { 200: templateResponse, ...adminErrorResponses },
      },
    },
    async (request) => templates.get(request.params.key),
  );

  app.put(
    '/admin/templates/:key',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: templateKeyParams,
        body: updateTemplateBody,
        response: { 200: templateResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      templates.update(request.admin, request.params.key, request.body, context(request)),
  );

  /**
   * Render, and send nothing. The same lint runs on the draft, so a preview cannot be used
   * to see what refused copy would have looked like in a reader's inbox.
   */
  app.post(
    '/admin/templates/:key/preview',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: templateKeyParams,
        body: previewTemplateBody,
        response: { 200: templatePreviewResponse, ...adminErrorResponses },
      },
    },
    async (request) => templates.preview(request.params.key, request.body ?? {}),
  );

  /* ---------------------------------------------------------------------- */
  /* Feedback                                                                */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/questionnaires',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        querystring: questionnairesQuery,
        response: { 200: questionnairesResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.listQuestionnaires(request.query),
  );

  app.post(
    '/admin/questionnaires',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        body: createQuestionnaireBody,
        response: { 201: questionnaireResponseEnvelope, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await feedback.createQuestionnaire(
        request.admin,
        request.body,
        context(request),
      );
      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/admin/questionnaires/:id',
    {
      preHandler: app.requireAdmin(ROLES.BETA),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateQuestionnaireBody,
        response: { 200: questionnaireResponseEnvelope, ...adminErrorResponses },
      },
    },
    async (request) =>
      feedback.updateQuestionnaire(request.admin, request.params.id, request.body, context(request)),
  );

  /**
   * Returned instruments. `summary` and `export.csv` are declared before `:id` so the file
   * reads in the order an operator meets them; the router prefers a static segment over a
   * parametric one regardless.
   */
  app.get(
    '/admin/questionnaire-responses',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        querystring: questionnaireResponsesQuery,
        response: { 200: questionnaireResponsesResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.listResponses(request.query),
  );

  app.get(
    '/admin/questionnaire-responses/summary',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        querystring: questionnaireResponseSummaryQuery,
        response: { 200: questionnaireResponseSummaryResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.summariseResponses(request.query),
  );

  /**
   * Gated on `FEEDBACK_TRIAGE` rather than `FEEDBACK_READ`, as the feedback export is: a
   * reviewer may read responses in the panel, where they are bounded and audited, without
   * being able to take a reviewer's name and every paragraph they wrote out of it.
   */
  app.get(
    '/admin/questionnaire-responses/export.csv',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_TRIAGE),
      schema: {
        headers: adminHeaders,
        querystring: questionnaireResponsesExportQuery,
        response: { 200: csvResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const { csv } = await feedback.exportResponsesCsv(
        request.admin,
        request.query,
        context(request),
      );
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="questionnaire-responses.csv"');
      return reply.send(Buffer.from(csv, 'utf8'));
    },
  );

  app.get(
    '/admin/questionnaire-responses/:id',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: questionnaireResponseDetailResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.getResponse(request.params.id),
  );

  /**
   * The free-form feedback queue. `summary` and `export.csv` are declared before `:id` for
   * readability; the router prefers a static segment over a parametric one regardless.
   */
  app.get(
    '/admin/feedback',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        querystring: feedbackQuery,
        response: { 200: feedbackListResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.listFeedback(request.query),
  );

  app.get(
    '/admin/feedback/summary',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        querystring: feedbackExportQuery,
        response: { 200: feedbackSummaryResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.summariseFeedback(request.query),
  );

  /**
   * The CSV is sent as a Buffer so Fastify's JSON serialiser never touches it, and with a
   * `Content-Disposition` filename because the file is opened by a human, elsewhere, later.
   */
  app.get(
    '/admin/feedback/export.csv',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_TRIAGE),
      schema: {
        headers: adminHeaders,
        querystring: feedbackExportQuery,
        response: { 200: csvResponse, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const { csv } = await feedback.exportFeedbackCsv(request.admin, request.query, context(request));
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="feedback.csv"');
      return reply.send(Buffer.from(csv, 'utf8'));
    },
  );

  app.get(
    '/admin/feedback/:id',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_READ),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: feedbackResponse, ...adminErrorResponses },
      },
    },
    async (request) => feedback.getFeedback(request.params.id),
  );

  app.patch(
    '/admin/feedback/:id',
    {
      preHandler: app.requireAdmin(ROLES.FEEDBACK_TRIAGE),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: updateFeedbackBody,
        response: { 200: feedbackResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      feedback.updateFeedback(request.admin, request.params.id, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Commerce — two ledgers, never merged                                    */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/donations',
    {
      preHandler: app.requireAdmin(ROLES.COMMERCE_READ),
      schema: {
        headers: adminHeaders,
        querystring: donationsQuery,
        response: { 200: donationsResponse, ...adminErrorResponses },
      },
    },
    async (request) => commerce.listDonations(request.query),
  );

  app.post(
    '/admin/donations/:id/refund',
    {
      preHandler: app.requireAdmin(ROLES.COMMERCE_REFUND),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: refundBody,
        response: { 200: refundResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      commerce.refundDonation(request.admin, request.params.id, request.body, context(request)),
  );

  app.get(
    '/admin/orders',
    {
      preHandler: app.requireAdmin(ROLES.COMMERCE_READ),
      schema: {
        headers: adminHeaders,
        querystring: ordersQuery,
        response: { 200: ordersResponse, ...adminErrorResponses },
      },
    },
    async (request) => commerce.listOrders(request.query),
  );

  app.post(
    '/admin/orders/:id/refund',
    {
      preHandler: app.requireAdmin(ROLES.COMMERCE_REFUND),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: refundBody,
        response: { 200: refundResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      commerce.refundOrder(request.admin, request.params.id, request.body, context(request)),
  );

  app.post(
    '/admin/orders/:id/fulfill',
    {
      preHandler: app.requireAdmin(ROLES.COMMERCE_FULFILL),
      schema: {
        headers: adminHeaders,
        params: idParams,
        body: fulfillBody,
        response: { 200: orderResponse, ...adminErrorResponses },
      },
    },
    async (request) =>
      commerce.fulfillOrder(request.admin, request.params.id, request.body, context(request)),
  );

  /* ---------------------------------------------------------------------- */
  /* Metrics — aggregate only                                                */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/metrics/funnel',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: funnelQuery,
        response: { 200: funnelResponse, ...adminErrorResponses },
      },
    },
    async (request) => metrics.funnel(request.query),
  );

  app.get(
    '/admin/metrics/events',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        querystring: eventsMetricQuery,
        response: { 200: eventsMetricResponse, ...adminErrorResponses },
      },
    },
    async (request) => metrics.eventSeries(request.query),
  );

  app.get(
    '/admin/metrics/cohorts/:id',
    {
      preHandler: app.requireAdmin(ROLES.ANY),
      schema: {
        headers: adminHeaders,
        params: idParams,
        response: { 200: cohortMetricsResponse, ...adminErrorResponses },
      },
    },
    async (request) => metrics.cohortMetrics(request.params.id),
  );

  /* ---------------------------------------------------------------------- */
  /* Ops                                                                     */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/admin/health/detail',
    {
      preHandler: app.requireAdmin(ROLES.OPS),
      schema: {
        headers: adminHeaders,
        response: { 200: healthDetailResponse, ...adminErrorResponses },
      },
    },
    async () => ops.healthDetail(),
  );

  app.get(
    '/admin/audit',
    {
      preHandler: app.requireAdmin(ROLES.OPS),
      schema: {
        headers: adminHeaders,
        querystring: auditQuery,
        response: { 200: auditResponse, ...adminErrorResponses },
      },
    },
    async (request) => ops.listAudit(request.query),
  );
}
