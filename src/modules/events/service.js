/**
 * Canonical event ingest.
 *
 * The eleven canonical events plus the proposed twelfth are the platform's only analytics.
 * There is no third-party pixel, no PostHog, no Google Analytics; the admin funnel is
 * computed from this collection and nothing else.
 *
 * Four rules are enforced here, in this order:
 *
 * 1. **The catalog governs.** A name outside `EVENT_NAMES` is dropped. The superseded
 *    061226 taxonomy (`threshold_viewed`, …) must never run alongside this one, and the way
 *    to guarantee that is to refuse to store it.
 * 2. **Payload keys are whitelisted per event name**, item-wise. An unknown key is dropped;
 *    it never fails the item, and an unusable item never fails the batch.
 * 3. **The server clock is authoritative.** `occurredAt` is client-reported and therefore
 *    advisory: a value that is unparseable, or that claims to be from the future, is
 *    replaced by `receivedAt`. Nothing downstream trusts a browser's clock.
 * 4. **Nothing identifying is ever stored.** No IP, no user-agent string, no geolocation,
 *    no birthdate, no age range, no free text authored by a reader, and no full referrer
 *    URL — `referrerDomain` is accepted only when it is genuinely a bare domain, and
 *    `entryPath` is stripped of any query string, which is where a share or access token
 *    would otherwise ride into the analytics store.
 *
 * The collection is append-only. There is no update path and no delete path in this module,
 * and no route exposes one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EVENT_BATCH_LIMIT,
  EVENT_NAMES,
  SCHEMA_VERSION,
  allowedPayloadFields,
} from '../../config/constants.js';
import { newId } from '../../lib/ids.js';

/** Longest string any payload value may carry. Nothing legitimate approaches it. */
const MAX_PAYLOAD_STRING = 128;

/** Longest path `entryPath` may carry, after the query string is removed. */
const MAX_ENTRY_PATH = 128;

/** How far ahead of the server clock a client timestamp may be before it is discarded. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** A bare hostname. Anything with a scheme, a path, credentials or a port is not one. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * The service's own version, stamped on every event so a funnel can be read against the
 * build that produced it. Read once, at import; a missing manifest is not a boot failure.
 */
const APP_VERSION = (() => {
  try {
    const path = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
})();

/**
 * @param {unknown} value A payload value.
 * @returns {boolean} True when the value is a scalar the collection may hold.
 */
function isStorableScalar(value) {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'string'
  );
}

/**
 * Normalise one whitelisted payload value, applying the field-specific privacy rules.
 *
 * @param {string} key The payload key.
 * @param {unknown} value The reported value.
 * @returns {unknown|undefined} The value to store, or undefined to drop the key.
 */
function normalisePayloadValue(key, value) {
  if (!isStorableScalar(value)) return undefined;

  if (typeof value !== 'string') return value;

  if (key === 'referrerDomain') {
    // A full referrer URL is prohibited. Only a bare domain survives; anything else — a
    // scheme, a path, a query string — is dropped rather than trimmed, because trimming a
    // URL down to a domain quietly accepts a client that is sending too much.
    const candidate = value.trim().toLowerCase();
    return DOMAIN_PATTERN.test(candidate) && candidate.length <= 253 ? candidate : undefined;
  }

  if (key === 'entryPath') {
    // Route shape only. A query string may carry a share token or an access grant.
    const [path] = value.split(/[?#]/, 1);
    if (!path.startsWith('/')) return undefined;
    return path.slice(0, MAX_ENTRY_PATH);
  }

  return value.length > MAX_PAYLOAD_STRING ? value.slice(0, MAX_PAYLOAD_STRING) : value;
}

/**
 * Resolve the authoritative timestamp for one item.
 *
 * @param {unknown} reported The client-reported `occurredAt`.
 * @param {Date} receivedAt The server clock.
 * @returns {Date} The timestamp to store.
 */
function resolveOccurredAt(reported, receivedAt) {
  if (typeof reported !== 'string') return receivedAt;
  const parsed = new Date(reported);
  if (Number.isNaN(parsed.getTime())) return receivedAt;
  if (parsed.getTime() > receivedAt.getTime() + CLOCK_SKEW_TOLERANCE_MS) return receivedAt;
  return parsed;
}

/**
 * Build the ingest service.
 *
 * @param {{ buffer: object, config: object, logger?: object }} deps Dependencies. `buffer`
 *        is the `workers/eventFlush.js` buffer; swapping it for a queue producer is the
 *        stage-2 upgrade and changes nothing else.
 * @returns {{ ingest: Function }} The service.
 */
export function createEventsService({ buffer, config, logger = null }) {
  if (!buffer) throw new TypeError('createEventsService: an event buffer is required.');

  return {
    /**
     * Accept one batch.
     *
     * @param {{ session: object, items: object[], now?: Date }} input The batch.
     * @returns {{ accepted: number }} How many items were kept.
     */
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
          // The only identity linkage that exists. Sessions are anonymous, and this
          // identifier stops resolving the moment a reader erases theirs.
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

    /** @returns {string|null} The version stamped on every event. */
    appVersion() {
      return APP_VERSION;
    },

    /** @returns {number} The configured flush batch ceiling, for diagnostics. */
    flushMaxBatch() {
      return config.events.flushMaxBatch;
    },
  };
}

export default createEventsService;
