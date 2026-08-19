/**
 * Regulated sharing.
 *
 * > "Sharing is human continuity transfer only after recognition, reflection,
 * > decompression, and regulation." — `content/rules.json`, locked
 *
 * The client evaluates the gate at every unit boundary so it knows whether to render
 * anything; this module re-evaluates it from scratch on every request, because a client
 * cannot be allowed to talk the server into opening a share window.
 *
 * ## The share-creation gate, in order (§9.2.6)
 *
 *   1. `gates.allow_sharing === true`
 *   2. the current unit is not a no-share zone (nor is any ancestor of it)
 *   3. `immersion_state ∈ {sharing_ready, return, convergence}` **or** a validated sharing
 *      window node is open on the current unit
 *   4. the rate limit — 5 per day per session
 *
 * Gate 4 is attached to the route as a named budget and is therefore evaluated by the
 * limiter before the handler runs. The ordering is not observable: every one of the four
 * produces the identical quiet `200 { eligible: false }`, so there is no way to tell from
 * outside which gate declined, and no gate is more dramatic than another.
 *
 * ## What is deliberately absent
 *
 * No counter, no acknowledgment, no confirmation animation, no "thank you", no unlock. A
 * share yields the sender nothing — that is what makes it not a referral reward and not a
 * viral loop. A receiver creates their own session and inherits nothing: no progress, no
 * band, no state, not even the knowledge that they arrived through someone.
 *
 * ## Windows
 *
 * `quiet_recognition` exists in the vocabulary but never opens in Phase 1: §9.2.3's
 * conservative default excludes raw `recognition_peak` nodes from
 * `SHARING_WINDOW_NODE_TYPES`, and no other source opens that window. It stays in the enum
 * so an authored prompt can declare it without the schema rejecting the prompt.
 */

import {
  PROMPT_FREQUENCIES,
  SCHEMA_VERSION,
  SHARING_READY_IMMERSION_STATES,
  SHARING_WINDOW_NODE_TYPES,
} from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { newId, shareToken as mintShareToken } from '../../lib/ids.js';
import { isCleanCopy } from '../../lib/rulesLint.js';
import { createContentRepository } from '../manuscript/service.js';
import { createGateEvaluator } from '../sessions/service.js';

/** Validated resonance node type → the window it opens (§9.2.3, conservative default). */
const NODE_TYPE_TO_WINDOW = Object.freeze({
  decompression_window: 'decompression',
  human_reconnection: 'human_reconnection',
  return_window: 'return',
  convergence_threshold: 'convergence',
});

/**
 * Immersion states that open a window in their own right. These mirror the states in which
 * the reader has demonstrably passed through decompression.
 */
const IMMERSION_STATE_TO_WINDOW = Object.freeze({
  decompression: 'decompression',
  return: 'return',
  convergence: 'convergence',
});

/**
 * `cooldown_units` has no authored semantics. [PROPOSED §5.2] it counts ManuscriptUnits
 * completed since the last prompt, defaulting to eight, on top of the hard cap of one
 * system-initiated prompt per session — which is the concrete meaning of `rare`.
 */
const DEFAULT_COOLDOWN_UNITS = 8;

/** The quiet refusal. One object, every path. */
const NOT_ELIGIBLE = Object.freeze({ eligible: false });

/**
 * Which windows are open for a session right now.
 *
 * @param {{ session: object, validatedNodeTypes: string[] }} input Session and node facts.
 * @returns {Set<string>} Open window types.
 */
function openWindows({ session, validatedNodeTypes }) {
  const windows = new Set();
  for (const nodeType of validatedNodeTypes ?? []) {
    if (!SHARING_WINDOW_NODE_TYPES.includes(nodeType)) continue;
    const window = NODE_TYPE_TO_WINDOW[nodeType];
    if (window) windows.add(window);
  }
  const fromImmersion = IMMERSION_STATE_TO_WINDOW[session?.immersion_state];
  if (fromImmersion) windows.add(fromImmersion);
  return windows;
}

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, content?: object,
 *           gates?: object }} deps Dependencies.
 * @returns {object} The sharing service.
 */
export function createSharingService({ db, config, logger = null, content = null, gates = null }) {
  const repository = content ?? createContentRepository({ db, logger });
  const evaluator = gates ?? createGateEvaluator({ db, content: repository, config });
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);
  const shareTokens = db.collection(COLLECTIONS.SHARE_TOKENS);
  const prompts = db.collection(COLLECTIONS.SHARING_PROMPTS);

  /**
   * Find one prompt permitted in one of the open windows.
   *
   * @param {Set<string>} windows Open window types.
   * @param {object} session The session document.
   * @returns {Promise<{ prompt: object, windowType: string }|null>} The prompt, or null.
   */
  async function selectPrompt(windows, session) {
    if (windows.size === 0) return null;

    const unitsSince = Number(session.unitsSinceLastPrompt) || 0;
    const candidates = await prompts
      .find(
        {
          active: true,
          frequency: { $in: [...PROMPT_FREQUENCIES] },
          allowed_window_types: { $in: [...windows] },
        },
        { sort: { prompt_id: 1 }, limit: 25 },
      )
      .toArray();

    for (const candidate of candidates) {
      // Human review is a precondition of activation; the flag is re-checked here so a
      // prompt activated by a defect still cannot reach a reader.
      if (candidate.requires_human_review === true && !(candidate.reviewedAt instanceof Date)) {
        continue;
      }
      const cooldown = Number.isInteger(candidate.cooldown_units)
        ? candidate.cooldown_units
        : DEFAULT_COOLDOWN_UNITS;
      if (unitsSince < cooldown) continue;
      if (typeof candidate.prompt_text !== 'string' || !isCleanCopy(candidate.prompt_text)) {
        logger?.warn?.(
          { promptId: candidate.prompt_id },
          'active sharing prompt failed the prohibited-terms lint and was withheld',
        );
        continue;
      }
      const windowType = (candidate.allowed_window_types ?? []).find((type) => windows.has(type));
      if (!windowType) continue;
      return { prompt: candidate, windowType };
    }
    return null;
  }

  /**
   * Record that a prompt was offered, once. The update is conditional, so two concurrent
   * eligibility checks cannot both hand out the session's single prompt.
   *
   * @param {object} session The session document.
   * @param {Date} now Timestamp.
   * @returns {Promise<boolean>} True when this call is the one that claimed the prompt.
   */
  async function claimPromptSlot(session, now) {
    const result = await sessions.updateOne(
      {
        _id: session._id,
        $or: [{ promptsShown: { $lt: 1 } }, { promptsShown: null }],
      },
      {
        $set: {
          promptsShown: 1,
          lastPromptAt: now,
          unitsSinceLastPrompt: 0,
          ...updateStamps(now),
        },
      },
    );
    return (result.modifiedCount ?? 0) > 0;
  }

  return {
    content: repository,

    /**
     * `GET /sharing/eligibility`.
     *
     * The prompt slot is claimed when a prompt is returned rather than when the client
     * reports having rendered it. That errs toward offering *fewer* prompts, which is the
     * only acceptable direction for this error to run.
     *
     * @param {object} session The authenticated session document.
     * @returns {Promise<{ eligible: boolean, prompt?: object }>} Eligibility.
     */
    async eligibility(session) {
      if (config.flags.sharingEnabled !== true) return { ...NOT_ELIGIBLE };

      const { gates: computed, facts } = await evaluator.evaluate(session);
      if (computed.allow_prompting !== true) return { ...NOT_ELIGIBLE };

      const windows = openWindows({ session, validatedNodeTypes: facts.validatedNodeTypes });
      const selected = await selectPrompt(windows, session);
      if (!selected) return { ...NOT_ELIGIBLE };

      const claimed = await claimPromptSlot(session, new Date());
      if (!claimed) return { ...NOT_ELIGIBLE };

      return {
        eligible: true,
        prompt: {
          promptId: selected.prompt.prompt_id,
          promptText: selected.prompt.prompt_text,
          visualTreatment: selected.prompt.visual_treatment,
          windowType: selected.windowType,
        },
      };
    },

    /**
     * `POST /shares`. Returns the created share, or the quiet refusal.
     *
     * @param {object} session The authenticated session document.
     * @param {{ promptId?: string }} input The validated request body.
     * @returns {Promise<{ created: true, token: string, shareUrl: string }
     *                   |{ created: false }>} The outcome.
     */
    async createShare(session, input = {}) {
      if (config.flags.sharingEnabled !== true) return { created: false };

      const { gates: computed, facts } = await evaluator.evaluate(session);

      // (1) the computed gate
      if (computed.allow_sharing !== true) return { created: false };

      // (2) the current unit, and every ancestor of it, must be outside a no-share zone
      const current = facts.current;
      if (current && current.isNoShareZoneInherited) return { created: false };

      // (3) a permitted immersion state, or a validated window node
      const windows = openWindows({ session, validatedNodeTypes: facts.validatedNodeTypes });
      const immersionPermits = SHARING_READY_IMMERSION_STATES.includes(session.immersion_state);
      if (!immersionPermits && windows.size === 0) return { created: false };

      // (4) the 5/day/session budget is attached to the route and has already passed.

      const now = new Date();
      const token = mintShareToken();
      const document = {
        _id: newId(),
        token,
        createdBySessionId: session._id,
        createdAtUnitId: current?.unitId ?? null,
        promptId: typeof input.promptId === 'string' ? input.promptId : null,
        // Private. Never returned by any route in this module.
        openCount: 0,
        firstOpenedAt: null,
        lastOpenedAt: null,
        // No expiry: a quiet, durable link. Revocation is the reader's control, not a clock.
        expiresAt: null,
        revoked: false,
        revokedAt: null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      await shareTokens.insertOne(document);
      await sessions.updateOne(
        { _id: session._id },
        { $inc: { sharesCreated: 1 }, $set: { ...updateStamps(now) } },
      );

      return {
        created: true,
        token,
        shareUrl: `${config.origins.publicOrigin}/s/${token}`,
      };
    },

    /**
     * `POST /shares/:token/revoke`. Only the creating session may revoke, and the response
     * is `204` either way — a differing answer would let anyone test whether a token exists.
     *
     * @param {object} session The authenticated session document.
     * @param {string} token The share token.
     * @returns {Promise<void>} Resolves when the attempt is complete.
     */
    async revoke(session, token) {
      const now = new Date();
      await shareTokens.updateOne(
        { token, createdBySessionId: session._id, revoked: false },
        { $set: { revoked: true, revokedAt: now, ...updateStamps(now) } },
      );
    },

    /**
     * `GET /shares/:token`. Records the private open touch and reports only that the entry
     * point is the beginning.
     *
     * @param {string} token The share token.
     * @returns {Promise<{ valid: boolean, entry: 'opening' }>} The lookup result.
     */
    async openShare(token) {
      const now = new Date();
      const updated = await shareTokens.findOneAndUpdate(
        { token, revoked: false },
        [
          {
            $set: {
              openCount: { $add: [{ $ifNull: ['$openCount', 0] }, 1] },
              firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
              lastOpenedAt: now,
              updatedAt: now,
            },
          },
        ],
        { returnDocument: 'after', projection: { _id: 1 } },
      );
      // An unknown or revoked token is not an error: the receiver simply begins at the
      // beginning, exactly as a first-time visitor would.
      return { valid: updated !== null, entry: 'opening' };
    },
  };
}

export default createSharingService;
