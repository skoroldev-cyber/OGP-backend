import { PROMPT_FREQUENCIES, SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { toFlag, toPaging } from '../../lib/schemas.js';
import { ApiError } from '../../plugins/errors.js';
import { toInteger, toIso } from './schemas.js';

const LOCKED_FREQUENCY = PROMPT_FREQUENCIES[0];

export const SHARING_AUDIT_ACTIONS = Object.freeze({
  CREATE: 'sharing_prompt.create',
  REVIEW: 'sharing_prompt.review',
});

export function toSharingPromptResponse(document) {
  return {
    id: document._id,
    promptId: document.prompt_id,
    promptType: document.prompt_type,
    promptText: document.prompt_text,
    allowedWindowTypes: Array.isArray(document.allowed_window_types)
      ? document.allowed_window_types
      : [],
    visualTreatment: document.visual_treatment,
    frequency: document.frequency ?? LOCKED_FREQUENCY,
    cooldownUnits: toInteger(document.cooldown_units),
    requiresHumanReview: document.requires_human_review === true,
    reviewedBy: document.reviewedBy ?? null,
    reviewedAt: toIso(document.reviewedAt),
    active: document.active === true,
    notes: document.notes ?? null,
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

export function createAdminSharingService({ db, logger = null }) {
  const prompts = db.collection(COLLECTIONS.SHARING_PROMPTS);

  async function requirePrompt(id) {
    const prompt = await prompts.findOne({ _id: id });
    if (!prompt) throw new ApiError(404, 'NOT_FOUND', 'That sharing prompt does not exist.');
    return prompt;
  }

  return {
    async list(query = {}) {
      const filter = {};
      const active = toFlag(query.active);
      if (active !== undefined) filter.active = active;
      if (query.promptType) filter.prompt_type = query.promptType;
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        prompts.find(filter, { sort: { prompt_id: 1 }, limit, skip }).toArray(),
        prompts.countDocuments(filter),
      ]);
      return { prompts: documents.map(toSharingPromptResponse), total: count };
    },

    async create(admin, input, options = {}) {
      assertCleanCopy(input.promptText, 'promptText');

      const now = new Date();
      const document = {
        _id: newId(),
        prompt_id: input.promptId,
        prompt_type: input.promptType,
        prompt_text: input.promptText,
        allowed_window_types: input.allowedWindowTypes,
        visual_treatment: input.visualTreatment,
        frequency: LOCKED_FREQUENCY,
        cooldown_units: toInteger(input.cooldownUnits),
        requires_human_review: input.requiresHumanReview !== false,
        reviewedBy: null,
        reviewedAt: null,
        active: false,
        notes: input.notes ?? null,
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await prompts.insertOne(document);
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(409, 'CONFLICT', 'That prompt identifier is already in use.');
        }
        throw error;
      }

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: SHARING_AUDIT_ACTIONS.CREATE,
        targetCollection: COLLECTIONS.SHARING_PROMPTS,
        targetId: document._id,
        after: { promptId: document.prompt_id, promptType: document.prompt_type, active: false },
        correlationId: options.correlationId ?? null,
      });

      return { prompt: toSharingPromptResponse(document) };
    },

    async update(admin, id, input, options = {}) {
      const prompt = await requirePrompt(id);
      const now = new Date();
      const set = { ...updateStamps(now) };

      if ('promptText' in input) {
        assertCleanCopy(input.promptText, 'promptText');
        set.prompt_text = input.promptText;
      }
      if ('promptType' in input) set.prompt_type = input.promptType;
      if ('allowedWindowTypes' in input) set.allowed_window_types = input.allowedWindowTypes;
      if ('visualTreatment' in input) set.visual_treatment = input.visualTreatment;
      if ('cooldownUnits' in input) set.cooldown_units = input.cooldownUnits;
      if ('requiresHumanReview' in input) set.requires_human_review = input.requiresHumanReview;
      if ('notes' in input) set.notes = input.notes;

      const copyChanged = 'promptText' in input && input.promptText !== prompt.prompt_text;
      if (copyChanged) {
        set.reviewedBy = null;
        set.reviewedAt = null;
        set.active = false;
      }

      if (input.reviewed === true && !copyChanged) {
        set.reviewedBy = admin._id;
        set.reviewedAt = now;
      } else if (input.reviewed === false) {
        set.reviewedBy = null;
        set.reviewedAt = null;
        set.active = false;
      }

      if ('active' in input) {
        if (input.active === true) {
          const requiresReview =
            'requiresHumanReview' in input
              ? input.requiresHumanReview !== false
              : prompt.requires_human_review === true;
          const reviewed = set.reviewedAt instanceof Date || prompt.reviewedAt instanceof Date;
          if (copyChanged || (requiresReview && !reviewed)) {
            throw new ApiError(
              409,
              'REVIEW_REQUIRED',
              'This prompt cannot be activated until a person has reviewed its current text.',
            );
          }
          set.active = true;
        } else {
          set.active = false;
        }
      }

      const updated = await prompts.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' },
      );

      const activating = set.active === true && prompt.active !== true;
      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: activating
          ? AUDIT_ACTIONS.SHARING_PROMPT_ACTIVATE
          : AUDIT_ACTIONS.SHARING_PROMPT_UPDATE,
        targetCollection: COLLECTIONS.SHARING_PROMPTS,
        targetId: id,
        before: { active: prompt.active === true, reviewedAt: toIso(prompt.reviewedAt) },
        after: {
          fields: Object.keys(set).filter((key) => key !== 'updatedAt'),
          active: updated.active === true,
        },
        correlationId: options.correlationId ?? null,
      });

      if (input.reviewed === true && !copyChanged) {
        await writeAudit(db, {
          actorType: 'admin',
          actorId: admin._id,
          action: SHARING_AUDIT_ACTIONS.REVIEW,
          targetCollection: COLLECTIONS.SHARING_PROMPTS,
          targetId: id,
          after: { reviewedBy: admin._id },
          correlationId: options.correlationId ?? null,
        });
      }

      if (activating) {
        logger?.info?.(
          { promptId: updated.prompt_id, adminId: admin._id },
          'a sharing prompt was activated',
        );
      }

      return { prompt: toSharingPromptResponse(updated) };
    },
  };
}

export default createAdminSharingService;
