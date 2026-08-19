/**
 * MongoDB connection, collection accessors and health probe.
 *
 * Decorates the instance with:
 *   `fastify.mongo`        — `{ client, db }`
 *   `fastify.db`           — the `Db` handle
 *   `fastify.collections`  — typed accessors from `db/collections.js`
 *   `fastify.mongoReady()` — a bounded liveness probe for `/admin/health/detail`
 *
 * Indexes and `$jsonSchema` validators are applied on boot when `config.autoIndex` /
 * `config.applyValidators` are set — true everywhere except production, where
 * `npm run db:indexes` runs as an explicit, reviewable deployment step. Applying a schema
 * change silently during a production rollout is how invariants get lost.
 *
 * The application's database user holds `readWrite` on the app database only; backups use
 * a separate credential (§9.6, least privilege).
 */

import tls from 'node:tls';
import { MongoClient } from 'mongodb';
import { createCollections } from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { applyValidators } from '../db/validators.js';

const READY_TIMEOUT_MS = 2000;

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @param {{ config: object }} options Plugin options.
 * @returns {Promise<void>} Resolves once connected.
 */
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
    // Atlas M0 (and some VPN paths) abort Node's default TLS 1.3 handshake with
    // "tlsv1 alert internal error". Compass uses TLS 1.2; pin the driver to match.
    secureContext: tls.createSecureContext({
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    }),
  });

  const db = client.db(config.mongo.db);
  let unavailable = false;

  try {
    await client.connect();
    // Prove the connection rather than trust the lazy driver handshake.
    await db.command({ ping: 1 });
    fastify.log.info(
      {
        db: config.mongo.db,
        uri: config.mongo.uri.replace(/\/\/[^@]*@/, '//***@'),
      },
      'mongo connected',
    );
  } catch (error) {
    // Outside production, an absent database is not a boot failure. The canonical reading path
    // is servable from the certified release on disk (§9.7: certified releases are immutable
    // and infinitely cacheable), so a developer with no Mongo running can still open the
    // manuscript, and the reading path — the majority path — is exactly the one that must never
    // depend on a server round trip.
    //
    // In production this is fatal. A reader must never be handed a degraded experience because
    // an operator forgot the connection string.
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

  /**
   * Bounded readiness probe. Never used on a reader-facing path — a slow database must
   * not become a slow `/healthz`.
   *
   * @returns {Promise<{ ok: boolean, latencyMs: number|null }>} Probe result.
   */
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

  // Schema work needs a live topology. Attempting it against a closed one produces one warning
  // per collection and one per index — eighty-two lines announcing, at length, the single fact
  // already stated above. A developer scanning that wall for a real problem finds none, which
  // is how real problems start being missed.
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
