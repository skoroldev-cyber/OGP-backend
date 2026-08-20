import { COLLECTIONS } from '../db/collections.js';

const BUFFER_CAPACITY_MULTIPLIER = 20;

export function createEventBuffer({ db, config, logger = null }) {
  if (!db) throw new TypeError('createEventBuffer: a database handle is required.');

  const collection = db.collection(COLLECTIONS.EVENTS);
  const intervalMs = config.events.flushIntervalMs;
  const maxBatch = config.events.flushMaxBatch;
  const capacity = maxBatch * BUFFER_CAPACITY_MULTIPLIER;

  let pending = [];
  let timer = null;
  let stopped = false;
  let dropped = 0;
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
    timer.unref?.();
  }

  async function writeBatch(batch) {
    if (batch.length === 0) return 0;
    try {
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
    add(documents) {
      if (!Array.isArray(documents) || documents.length === 0) return 0;
      if (stopped) {
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

    async flushNow() {
      clearTimer();
      return flush();
    },

    async stop() {
      stopped = true;
      clearTimer();
      const written = await flush();
      if (dropped > 0) {
        logger?.warn?.({ dropped }, 'event buffer discarded events over its lifetime');
      }
      return written;
    },

    size() {
      return pending.length;
    },

    dropped() {
      return dropped;
    },
  };
}

export default createEventBuffer;
