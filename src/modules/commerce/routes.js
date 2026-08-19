/**
 * Commerce routes.
 *
 * The route table is the first place the locked separation is visible, and it is meant to
 * be: `/commerce/donations*` and `/commerce/orders` + `/commerce/reservations` are two
 * groups served by two services over two collections with two receipt series. There is no
 * cart endpoint, no combined checkout, and no route that can accept a contribution and a
 * product in the same request.
 *
 * Auth follows BUILD_CONTRACT §4.4 exactly: the catalog, receipts and transcript access are
 * public (**P**), the two checkouts and the reservation carry the reader's anonymous
 * session (**S**), and the webhook is authenticated by signature alone (**W**).
 *
 * Rate limits: payment attempts use the `commerceAttempt` budget (10/hour/session); the
 * free-access grant uses `mailTrigger`, because it mints access and sends mail without a
 * gateway in the way; receipts and transcript links use `publicTokenLookup`, so a signed
 * token cannot be enumerated cheaply.
 */

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

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the routes are registered.
 */
export default async function routes(app, opts) {
  const config = opts.config ?? app.config;
  const logger = app.log;

  const grants = createGrantsService({ db: app.db, config, logger });
  const products = createProductsService({ db: app.db, config });
  const donations = createDonationsService({ db: app.db, config, logger, grants });
  const orders = createOrdersService({ db: app.db, config, logger, products });
  const receipts = createReceiptsService({ db: app.db });
  const webhooks = createWebhooksService({ db: app.db, config, logger });

  /* ---------------------------------------------------------------------- */
  /* Catalog                                                                 */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Workflow A — contributions                                              */
  /* ---------------------------------------------------------------------- */

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
          // A decline is an outcome, not an error: it carries its own shape, and the copy
          // that renders it says plainly that nothing was charged.
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

  /* ---------------------------------------------------------------------- */
  /* Workflow B — printed editions                                           */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Accountless artefacts                                                   */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Gateway callbacks                                                       */
  /* ---------------------------------------------------------------------- */

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
        // The signature covers the exact bytes NMI sent. `app.js` preserves them for this
        // one endpoint; re-serialising the parsed body here would break every signature.
        rawBody: request.rawBody,
        signatureHeader: request.headers['webhook-signature'],
        body: request.body,
        correlationId: request.id,
      }),
  );
}
