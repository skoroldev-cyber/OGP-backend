import { createDonationsService } from './donations.js';
import { createGrantsService, createReceiptsService } from './grants.js';
import { createOrdersService } from './orders.js';
import { createProductsService } from './products.js';
import { createWebhooksService } from './webhooks.js';
import {
  commerceErrorResponses,
  commerceHeaders,
  createDonationBody,
  createOrderBody,
  createReservationBody,
  digitalAccessResponse,
  donationCreatedResponse,
  freeAccessBody,
  orderCreatedResponse,
  paymentDeclinedResponse,
  productsResponse,
  receiptParams,
  receiptQuery,
  receiptResponse,
  reservationCreatedResponse,
  transcriptParams,
  transcriptResponse,
  webhookBody,
  webhookHeaders,
  webhookResponse,
} from './schemas.js';

export default async function routes(app, opts) {
  const config = opts.config ?? app.config;
  const logger = app.log;

  const grants = createGrantsService({ db: app.db, config, logger });
  const products = createProductsService({ db: app.db, config });
  const donations = createDonationsService({ db: app.db, config, logger, grants });
  const orders = createOrdersService({ db: app.db, config, logger, products });
  const receipts = createReceiptsService({ db: app.db });
  const webhooks = createWebhooksService({ db: app.db, config, logger });

  app.get(
    '/commerce/products',
    {
      config: { rateLimit: app.rateLimits.publicTokenLookup },
      schema: {
        response: {
          200: productsResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async () => products.listActive(),
  );

  app.post(
    '/commerce/donations',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.commerceAttempt },
      schema: {
        headers: commerceHeaders,
        body: createDonationBody,
        response: {
          201: donationCreatedResponse,
          402: paymentDeclinedResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await donations.create(request.session, request.body, {
        correlationId: request.id,
      });
      if (result.declined) {
        reply.code(402);
        return { status: 'declined', reason: result.reason };
      }
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/commerce/donations/free-access',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.mailTrigger },
      schema: {
        headers: commerceHeaders,
        body: freeAccessBody,
        response: {
          201: digitalAccessResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await donations.freeAccess(request.body);
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/commerce/orders',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.commerceAttempt },
      schema: {
        headers: commerceHeaders,
        body: createOrderBody,
        response: {
          201: orderCreatedResponse,
          402: paymentDeclinedResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await orders.createPurchase(request.session, request.body, {
        correlationId: request.id,
      });
      if (result.declined) {
        reply.code(402);
        return { status: 'declined', reason: result.reason };
      }
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/commerce/reservations',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.commerceAttempt },
      schema: {
        headers: commerceHeaders,
        body: createReservationBody,
        response: {
          201: reservationCreatedResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await orders.createReservation(request.session, request.body, {
        correlationId: request.id,
      });
      reply.code(201);
      return result;
    },
  );

  app.get(
    '/commerce/receipts/:receiptNumber',
    {
      config: { rateLimit: app.rateLimits.publicTokenLookup },
      schema: {
        params: receiptParams,
        querystring: receiptQuery,
        response: {
          200: receiptResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request) =>
      receipts.view({
        receiptNumber: request.params.receiptNumber,
        token: request.query.t,
      }),
  );

  app.get(
    '/transcript/:accessToken',
    {
      config: { rateLimit: app.rateLimits.publicTokenLookup },
      schema: {
        params: transcriptParams,
        response: {
          200: transcriptResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request) => grants.manifest(request.params.accessToken),
  );

  app.post(
    '/webhooks/nmi',
    {
      schema: {
        headers: webhookHeaders,
        body: webhookBody,
        response: {
          200: webhookResponse,
          ...commerceErrorResponses,
        },
      },
    },
    async (request) =>
      webhooks.handle({
        rawBody: request.rawBody,
        signatureHeader: request.headers['webhook-signature'],
        body: request.body,
        correlationId: request.id,
      }),
  );
}
