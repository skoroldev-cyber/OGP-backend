import tls from 'node:tls';
import { MongoClient } from 'mongodb';
import { createCollections } from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { applyValidators } from '../db/validators.js';

const READY_TIMEOUT_MS = 2000;

async function mongoPlugin(fastify, options) {
  const { config } = options;

  const client = new MongoClient(config.mongo.uri, {
    maxPoolSize: config.mongo.maxPoolSize,
    serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMS,
    retryWrites: true,
    retryReads: true,
    writeConcern: { w: 'majority' },
    appName: 'ogp-api',
    family: 4,
    secureContext: tls.createSecureContext({
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    }),
  });

  const db = client.db(config.mongo.db);
  let unavailable = false;

  try {
    await client.connect();
    await db.command({ ping: 1 });
    fastify.log.info(
      {
        db: config.mongo.db,
        uri: config.mongo.uri.replace(/\/\/[^@]*@/, '//***@'),
      },
      'mongo connected',
    );
  } catch (error) {
    if (config.env === 'production') throw error;

    fastify.log.warn(
      { reason: error.message, uri: config.mongo.uri.replace(/\/\/[^@]*@/, '//***@') },
      'mongo is unreachable — starting in read-only mode. Session, event, sharing, beta and ' +
        'commerce routes will fail; the manuscript is served from the certified release on disk.',
    );
    unavailable = true;
  }

  fastify.decorate('mongoUnavailable', unavailable);
  fastify.decorate('mongo', { client, db });
  fastify.decorate('db', db);
  fastify.decorate('collections', createCollections(db));

  fastify.decorate('mongoReady', async function mongoReady() {
    const started = Date.now();
    try {
      await Promise.race([
        db.command({ ping: 1 }),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('ping timeout')), READY_TIMEOUT_MS).unref?.();
        }),
      ]);
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: null };
    }
  });

  if (fastify.mongoUnavailable) {
    fastify.log.info(
      'skipping validators and indexes — no database. Run scripts/ensure-indexes.mjs once one is available.',
    );
  } else {
    if (config.applyValidators) {
      const result = await applyValidators(db, { logger: fastify.log });
      if (result.failures.length > 0) {
        fastify.log.warn(
          { failures: result.failures.length },
          'some collection validators could not be applied',
        );
      }
    }

    if (config.autoIndex) {
      await ensureIndexes(db, { logger: fastify.log });
    }
  }

  fastify.addHook('onClose', async () => {
    await client.close();
    fastify.log.info('mongo connection closed');
  });
}

mongoPlugin[Symbol.for('skip-override')] = true;
mongoPlugin[Symbol.for('fastify.display-name')] = 'ogp-mongo';

export default mongoPlugin;
