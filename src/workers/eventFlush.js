/**
 * Event flush buffer — stage 1 of the §9.8 event pipeline.
 *
 * `POST /events` is the highest-frequency write in the platform and the least important
 * one to any individual reader: it is fire-and-forget by contract, and a failure in it must
 * never surface on the reading path. So the route hands validated documents to this buffer
 * and answers `202` immediately; the buffer performs one `insertMany` every
 * `config.events.flushIntervalMs` or every `config.events.flushMaxBatch` documents,
 * whichever comes first.
 *
 * ## Upgrade path (§9.8.2) — the `POST /events` contract never changes
 *
 * Three stages are planned; only the first is built, and the seam between them is this
 * file's public surface (`add`, `flushNow`, `stop`).
 *
 *   Stage 1 — **now**: in-process buffer, `insertMany` flush. Single node. The one loss
 *             window is an unclean process kill; `flushNow()` closes it for every ordinary
 *             shutdown, and `server.js` awaits it.
 *   Stage 2 — **multi-node**: Redis + BullMQ. `add()` becomes `queue.addBulk(...)` and a
 *             worker process drains the queue into MongoDB with the same document shape.
 *             `flushNow()` becomes a no-op that awaits in-flight `addBulk` calls, because
 *             durability moves to Redis. `RATE_LIMIT_REDIS_URL` already declares the Redis
 *             endpoint; an `EVENT_QUEUE_REDIS_URL` joins it. The route, the payload
 *             whitelist, the `202 { accepted }` response and the document shape are all
 *             unchanged, so no client and no dashboard query is affected.
 *   Stage 3 — **mass scale**: a managed stream (Kafka-class) behind the same `add()`, with
 *             MongoDB fed by a sink consumer and rollups computed downstream.
 *
 * Nothing above stage 1 is built now. What matters is that none of it requires the ingest
 * route, the event catalog or the collection shape to change.
 */

import { COLLECTIONS } from '../db/collections.js';

/**
 * Ceiling on buffered documents, as a multiple of the flush batch size. Past it the oldest
 * documents are dropped: an unbounded buffer turns a database outage into a memory
 * exhaustion, and analytics telemetry is the correct thing to lose first.
 */
const BUFFER_CAPACITY_MULTIPLIER = 20;

/**
 * Create the buffer.
 *
 * @param {{ db: import('mongodb').Db, config: object, logger?: object }} deps Dependencies.
 * @returns {{ add: Function, flushNow: Function, stop: Function, size: Function,
 *             dropped: Function }} The buffer.
 */
export function createEventBuffer({ db, config, logger = null }) {
  if (!db) throw new TypeError('createEventBuffer: a database handle is required.');

  const collection = db.collection(COLLECTIONS.EVENTS);
  const intervalMs = config.events.flushIntervalMs;
  const maxBatch = config.events.flushMaxBatch;
  const capacity = maxBatch * BUFFER_CAPACITY_MULTIPLIER;

  /** @type {object[]} */
  let pending = [];
  let timer = null;
  let stopped = false;
  let dropped = 0;
  /** Serialises flushes so two `insertMany` calls never race over the same slice. */
  let chain = Promise.resolve();

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    if (timer !== null || stopped || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, intervalMs);
    // A pending flush must never hold the process open on its own.
    timer.unref?.();
  }

  async function writeBatch(batch) {
    if (batch.length === 0) return 0;
    try {
      // Unordered: one rejected document must not discard the rest of the batch.
      const result = await collection.insertMany(batch, { ordered: false });
      return result.insertedCount ?? batch.length;
    } catch (error) {
      const inserted = error?.result?.insertedCount ?? error?.insertedCount ?? 0;
      logger?.error?.(
        { err: error, attempted: batch.length, inserted },
        'event batch could not be written; the batch is dropped',
      );
      return inserted;
    }
  }

  /**
   * Drain everything currently buffered.
   *
   * @returns {Promise<number>} How many documents were written.
   */
  function flush() {
    chain = chain.then(async () => {
      let written = 0;
      while (pending.length > 0) {
        const batch = pending.splice(0, maxBatch);
        written += await writeBatch(batch);
      }
      return written;
    });
    return chain;
  }

  return {
    /**
     * Buffer documents for the next flush. Never throws: the caller is on the reading path.
     *
     * @param {object[]} documents Ready-to-insert event documents.
     * @returns {number} How many documents were accepted into the buffer.
     */
    add(documents) {
      if (!Array.isArray(documents) || documents.length === 0) return 0;
      if (stopped) {
        // After `stop()` the buffer accepts nothing; the caller has already answered 202 and
        // the process is on its way down.
        dropped += documents.length;
        return 0;
      }

      pending.push(...documents);

      if (pending.length > capacity) {
        const overflow = pending.length - capacity;
        pending.splice(0, overflow);
        dropped += overflow;
        logger?.warn?.(
          { dropped: overflow, capacity },
          'event buffer is over capacity; the oldest buffered events were dropped',
        );
      }

      if (pending.length >= maxBatch) {
        clearTimer();
        void flush();
      } else {
        schedule();
      }
      return documents.length;
    },

    /**
     * Flush synchronously with respect to the caller. Awaited during shutdown so a redeploy
     * never silently discards a reader's completed chapter.
     *
     * @returns {Promise<number>} How many documents were written.
     */
    async flushNow() {
      clearTimer();
      return flush();
    },

    /**
     * Stop accepting new documents and drain what is buffered.
     *
     * @returns {Promise<number>} How many documents were written.
     */
    async stop() {
      stopped = true;
      clearTimer();
      const written = await flush();
      if (dropped > 0) {
        logger?.warn?.({ dropped }, 'event buffer discarded events over its lifetime');
      }
      return written;
    },

    /** @returns {number} Documents currently buffered. */
    size() {
      return pending.length;
    },

    /** @returns {number} Documents discarded over the buffer's lifetime. */
    dropped() {
      return dropped;
    },
  };
}

export default createEventBuffer;
