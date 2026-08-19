/**
 * Event ingest route — `POST /events`.
 *
 * One route, one method. The collection is append-only: **no update route and no delete
 * route exists here, and none may ever be added.** Retention is a background pass
 * (`workers/retention.js`), not an API surface.
 *
 * The route is fire-and-forget. It answers `202 { accepted }` as soon as the batch has been
 * validated and buffered; the database write happens later, in the flush worker. A failure
 * in that write is logged and never reaches the reader, because analytics telemetry must
 * never be able to interrupt someone's reading.
 */

import { createEventsService } from './service.js';
import { eventBatchBody, eventBatchResponse, eventErrorResponses, eventHeaders } from './schemas.js';
import { createEventBuffer } from '../../workers/eventFlush.js';

/**
 * @param {import('fastify').FastifyInstance} app The encapsulated instance.
 * @param {{ config: object }} opts Registration options from `app.js`.
 * @returns {Promise<void>} Resolves when the route is registered.
 */
export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const buffer = createEventBuffer({ db: app.db, config: appConfig, logger: app.log });
  const service = createEventsService({ buffer, config: appConfig, logger: app.log });

  // `server.js` looks for `app.flushEvents` and also honours an `onClose` hook. The hook is
  // the operative path: decorators do not propagate from an encapsulated plugin up to the
  // root instance, and Fastify closes plugins in reverse registration order — this module
  // registered after `plugins/mongo.js`, so the connection is still open when it drains.
  app.decorate('flushEvents', () => buffer.flushNow());
  app.addHook('onClose', async () => {
    const written = await buffer.stop();
    app.log.info({ written, dropped: buffer.dropped() }, 'event buffer drained on shutdown');
  });

  app.post(
    '/events',
    {
      preHandler: app.requireSession,
      config: { rateLimit: app.rateLimits.eventIngest },
      schema: {
        headers: eventHeaders,
        body: eventBatchBody,
        response: {
          202: eventBatchResponse,
          ...eventErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { accepted } = service.ingest({
        session: request.session,
        items: request.body.events,
      });
      reply.code(202);
      return { accepted };
    },
  );
}
