import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EVENT_BATCH_LIMIT,
  EVENT_NAMES,
  SCHEMA_VERSION,
  allowedPayloadFields,
} from '../../config/constants.js';
import { newId } from '../../lib/ids.js';

const MAX_PAYLOAD_STRING = 128;

const MAX_ENTRY_PATH = 128;

const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const APP_VERSION = (() => {
  try {
    const path = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
})();

function isStorableScalar(value) {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'string'
  );
}

function normalisePayloadValue(key, value) {
  if (!isStorableScalar(value)) return undefined;

  if (typeof value !== 'string') return value;

  if (key === 'referrerDomain') {
    const candidate = value.trim().toLowerCase();
    return DOMAIN_PATTERN.test(candidate) && candidate.length <= 253 ? candidate : undefined;
  }

  if (key === 'entryPath') {
    const [path] = value.split(/[?#]/, 1);
    if (!path.startsWith('/')) return undefined;
    return path.slice(0, MAX_ENTRY_PATH);
  }

  return value.length > MAX_PAYLOAD_STRING ? value.slice(0, MAX_PAYLOAD_STRING) : value;
}

function resolveOccurredAt(reported, receivedAt) {
  if (typeof reported !== 'string') return receivedAt;
  const parsed = new Date(reported);
  if (Number.isNaN(parsed.getTime())) return receivedAt;
  if (parsed.getTime() > receivedAt.getTime() + CLOCK_SKEW_TOLERANCE_MS) return receivedAt;
  return parsed;
}

export function createEventsService({ buffer, config, logger = null }) {
  if (!buffer) throw new TypeError('createEventsService: an event buffer is required.');

  return {
    ingest({ session, items, now = new Date() }) {
      const batch = Array.isArray(items) ? items.slice(0, EVENT_BATCH_LIMIT) : [];
      const documents = [];

      for (const item of batch) {
        if (!EVENT_NAMES.includes(item?.name)) continue;

        const allowed = allowedPayloadFields(item.name);
        const payload = {};
        const reported = item.payload;
        if (reported !== null && typeof reported === 'object' && !Array.isArray(reported)) {
          for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(reported, key)) continue;
            const normalised = normalisePayloadValue(key, reported[key]);
            if (normalised !== undefined) payload[key] = normalised;
          }
        }

        documents.push({
          _id: newId(),
          sessionId: session._id,
          name: item.name,
          occurredAt: resolveOccurredAt(item.occurredAt, now),
          receivedAt: now,
          payload,
          contentLayer: session.contentLayer ?? null,
          appVersion: APP_VERSION,
          createdAt: now,
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        });
      }

      if (documents.length > 0) buffer.add(documents);
      if (documents.length < batch.length) {
        logger?.debug?.(
          { received: batch.length, accepted: documents.length },
          'event batch contained items outside the canonical catalog',
        );
      }

      return { accepted: documents.length };
    },

    appVersion() {
      return APP_VERSION;
    },

    flushMaxBatch() {
      return config.events.flushMaxBatch;
    },
  };
}

export default createEventsService;
