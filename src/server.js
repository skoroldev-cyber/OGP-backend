/**
 * Process entry point.
 *
 * Boot: load configuration (which fails fast in production), build the app, listen.
 *
 * Shutdown on SIGTERM or SIGINT, in this order:
 *   1. Stop accepting new work — Fastify answers in-flight requests and returns 503 to
 *      anything arriving after the close begins.
 *   2. Flush the event buffer. The event write path is fire-and-forget and batched; a
 *      redeploy must not silently discard a reader's completed chapter. The events module
 *      decorates `app.flushEvents` (and/or registers its own `onClose` hook); both are
 *      honoured here.
 *   3. Close the Mongo connection (the mongo plugin's `onClose` hook).
 *
 * A hard timer bounds the whole sequence. A process that will not leave must be made to.
 */

import config from './config/index.js';
import { buildApp } from './app.js';

let app = null;
let shuttingDown = false;

/**
 * Run the graceful shutdown sequence exactly once.
 *
 * @param {string} signal The signal or reason that triggered shutdown.
 * @param {number} [exitCode] Process exit code.
 * @returns {Promise<void>} Resolves just before the process exits.
 */
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const log = app?.log ?? console;
  log.info?.({ signal }, 'shutdown requested');

  const forceTimer = setTimeout(() => {
    log.error?.({ signal }, 'shutdown exceeded its budget; forcing exit');
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, config.shutdownTimeoutMs);
  forceTimer.unref();

  try {
    if (app && typeof app.flushEvents === 'function') {
      await app.flushEvents();
      log.info?.('event buffer flushed');
    }
  } catch (error) {
    log.error?.({ err: error }, 'event buffer could not be flushed');
  }

  try {
    if (app) await app.close();
  } catch (error) {
    log.error?.({ err: error }, 'shutdown encountered an error while closing');
    exitCode = exitCode === 0 ? 1 : exitCode;
  }

  clearTimeout(forceTimer);
  process.exit(exitCode);
}

/**
 * Boot the service.
 *
 * @returns {Promise<void>} Resolves once the listener is bound.
 */
async function start() {
  app = await buildApp({ config });

  for (const warning of config.warnings) {
    app.log.warn({ configuration: true }, warning);
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      env: config.env,
      port: config.port,
      flags: config.flags,
      gateway: config.nmi.mock ? 'mock' : 'live',
      mail: config.mail.transport,
    },
    'one global people api listening',
  );
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  const log = app?.log ?? console;
  log.error?.({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  const log = app?.log ?? console;
  log.error?.({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

try {
  await start();
} catch (error) {
  // The logger may not exist yet — a configuration failure happens before the app does.
  console.error('[ogp-api] failed to start:', error.message);
  process.exitCode = 1;
  if (app) await shutdown('startupFailure', 1);
  else process.exit(1);
}
