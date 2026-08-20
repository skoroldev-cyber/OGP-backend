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
