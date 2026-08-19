/**
 * Feedback routes — the Beta Test Questionnaire, and free-form reader feedback.
 *
 * Every route here requires a session and **none is gated on arc completion**, which is a
 * change from how the questionnaire routes began. They used to refuse until
 * `progress.openingArcCompleted`, on the reading that §5.8's "Please read the Opening Arc
 * without stopping to edit" makes the ordering a server concern.
 *
 * It is not one. The ordering law forbids a feedback *surface* mid-read, and that is
 * enforced where surfaces are decided: while reading, a reader may only mark a passage
 * (§3.13), and the instrument is reached at S13 from "Continue to Observations". Meanwhile
 * the instrument's own reviewer metadata records the reading format as DOCX, PDF, print or
 * immersive room — three of which happen entirely outside this application, leaving the
 * server no way to know the arc was read. Gating on a flag it cannot observe locked out
 * precisely the reviewers the instrument was written for.
 *
 * So the ordering stays a property of the client's mounting rules, and the server accepts a
 * completed instrument from whoever completed one.
 */

import { createFeedbackService } from './service.js';
import {
  activeQuestionnaireResponse,
  createFeedbackBody,
  createFeedbackResponse,
  feedbackErrorResponses,
  feedbackHeaders,
  ownFeedbackQuery,
  ownFeedbackResponse,
  submitResponseBody,
  submitResponseResponse,
} from './schemas.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, _opts) {
  const service = createFeedbackService({ db: app.db, logger: app.log });

  app.get(
    '/questionnaires/active',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: feedbackHeaders,
        response: {
          200: activeQuestionnaireResponse,
          ...feedbackErrorResponses,
        },
      },
    },
    async (request) => service.activeQuestionnaire(request.session),
  );

  // On the feedback write budget rather than the reading path's. Completing the instrument
  // is a deliberate act a reviewer performs once or twice, so the generous read allowance is
  // the wrong shape: what this limit blunts is automated submission, not a person.
  app.post(
    '/questionnaire-responses',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.feedbackCreate },
      schema: {
        headers: feedbackHeaders,
        body: submitResponseBody,
        response: {
          201: submitResponseResponse,
          ...feedbackErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.submitResponse(request.session, request.body);
      reply.code(201);
      return result;
    },
  );

  /**
   * Rate-limited on its own budget rather than the reading path's: a reader writes feedback
   * a handful of times, and the limit exists to blunt automated submission, not to hurry
   * anybody. It answers with the ordinary calm 429 rather than a quiet success — a
   * submission that silently disappeared would lose written work.
   */
  app.post(
    '/feedback',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.feedbackCreate },
      schema: {
        headers: feedbackHeaders,
        body: createFeedbackBody,
        response: {
          201: createFeedbackResponse,
          ...feedbackErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.submitFeedback(request.session, request.body);
      reply.code(201);
      return result;
    },
  );

  app.get(
    '/feedback/mine',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.readingPath },
      schema: {
        headers: feedbackHeaders,
        querystring: ownFeedbackQuery,
        response: {
          200: ownFeedbackResponse,
          ...feedbackErrorResponses,
        },
      },
    },
    async (request) => service.listOwnFeedback(request.session),
  );
}
