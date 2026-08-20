import { createEventsService } from './service.js';
import { eventBatchBody, eventBatchResponse, eventErrorResponses, eventHeaders } from './schemas.js';
import { createEventBuffer } from '../../workers/eventFlush.js';

export default async function routes(app, opts) {
  const appConfig = opts.config ?? app.config;
  const buffer = createEventBuffer({ db: app.db, config: appConfig, logger: app.log });
  const service = createEventsService({ buffer, config: appConfig, logger: app.log });

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
