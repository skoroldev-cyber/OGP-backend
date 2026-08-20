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

const NODE_TYPE_TO_WINDOW = Object.freeze({
  decompression_window: 'decompression',
  human_reconnection: 'human_reconnection',
  return_window: 'return',
  convergence_threshold: 'convergence',
});

const IMMERSION_STATE_TO_WINDOW = Object.freeze({
  decompression: 'decompression',
  return: 'return',
  convergence: 'convergence',
});

const DEFAULT_COOLDOWN_UNITS = 8;

const NOT_ELIGIBLE = Object.freeze({ eligible: false });

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

export function createSharingService({ db, config, logger = null, content = null, gates = null }) {
  const repository = content ?? createContentRepository({ db, logger });
  const evaluator = gates ?? createGateEvaluator({ db, content: repository, config });
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);
  const shareTokens = db.collection(COLLECTIONS.SHARE_TOKENS);
  const prompts = db.collection(COLLECTIONS.SHARING_PROMPTS);

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

    async createShare(session, input = {}) {
      if (config.flags.sharingEnabled !== true) return { created: false };

      const { gates: computed, facts } = await evaluator.evaluate(session);

      if (computed.allow_sharing !== true) return { created: false };

      const current = facts.current;
      if (current && current.isNoShareZoneInherited) return { created: false };

      const windows = openWindows({ session, validatedNodeTypes: facts.validatedNodeTypes });
      const immersionPermits = SHARING_READY_IMMERSION_STATES.includes(session.immersion_state);
      if (!immersionPermits && windows.size === 0) return { created: false };

      const now = new Date();
      const token = mintShareToken();
      const document = {
        _id: newId(),
        token,
        createdBySessionId: session._id,
        createdAtUnitId: current?.unitId ?? null,
        promptId: typeof input.promptId === 'string' ? input.promptId : null,
        openCount: 0,
        firstOpenedAt: null,
        lastOpenedAt: null,
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

    async revoke(session, token) {
      const now = new Date();
      await shareTokens.updateOne(
        { token, createdBySessionId: session._id, revoked: false },
        { $set: { revoked: true, revokedAt: now, ...updateStamps(now) } },
      );
    },

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
      return { valid: updated !== null, entry: 'opening' };
    },
  };
}

export default createSharingService;
