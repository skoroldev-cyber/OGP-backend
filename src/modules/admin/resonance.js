import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { toFlag, toPaging } from '../../lib/schemas.js';
import { ApiError } from '../../plugins/errors.js';
import { toInteger, toIso } from './schemas.js';

export const RESONANCE_AUDIT_ACTIONS = Object.freeze({
  CREATE: 'resonance_node.create',
  UPDATE: 'resonance_node.update',
});

export function toResonanceNodeResponse(document) {
  return {
    id: document._id,
    nodeId: document.node_id,
    manuscriptUnitId: document.manuscript_unit_id,
    nodeType: document.node_type,
    scores: document.scores ?? null,
    chapter: toInteger(document.chapter),
    section: document.section ?? null,
    summary: document.summary ?? null,
    validated: document.qa_status?.validated ?? null,
    validatedBy: document.qa_status?.validatedBy ?? null,
    validatedAt: toIso(document.qa_status?.validatedAt),
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
  };
}

export function createAdminResonanceService({ db, logger = null }) {
  const nodes = db.collection(COLLECTIONS.RESONANCE_NODES);
  const units = db.collection(COLLECTIONS.MANUSCRIPT_UNITS);

  async function requireNode(id) {
    const node = await nodes.findOne({ _id: id });
    if (!node) throw new ApiError(404, 'NOT_FOUND', 'That resonance node does not exist.');
    return node;
  }

  return {
    async list(query = {}) {
      const filter = {};
      if (query.manuscriptUnitId) filter.manuscript_unit_id = query.manuscriptUnitId;
      if (query.nodeType) filter.node_type = query.nodeType;
      const validated = toFlag(query.validated);
      if (validated !== undefined) filter['qa_status.validated'] = validated;
      const { limit, skip } = toPaging(query);
      const [documents, count] = await Promise.all([
        nodes.find(filter, { sort: { node_id: 1 }, limit, skip }).toArray(),
        nodes.countDocuments(filter),
      ]);
      return { nodes: documents.map(toResonanceNodeResponse), total: count };
    },

    async create(admin, input, options = {}) {
      const unit = await units.findOne(
        { unitId: input.manuscriptUnitId },
        { projection: { _id: 1 } },
      );
      if (!unit) {
        throw new ApiError(422, 'UNIT_NOT_FOUND', 'That manuscript unit does not exist.');
      }

      const now = new Date();
      const document = {
        _id: newId(),
        node_id: input.nodeId,
        manuscript_unit_id: input.manuscriptUnitId,
        node_type: input.nodeType,
        scores: input.scores ?? null,
        chapter: toInteger(input.chapter),
        section: input.section ?? null,
        summary: input.summary ?? null,
        qa_status: { validated: false, validatedBy: null, validatedAt: null },
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await nodes.insertOne(document);
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(409, 'CONFLICT', 'That node identifier is already in use.');
        }
        throw error;
      }

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: RESONANCE_AUDIT_ACTIONS.CREATE,
        targetCollection: COLLECTIONS.RESONANCE_NODES,
        targetId: document._id,
        after: {
          nodeId: document.node_id,
          nodeType: document.node_type,
          manuscriptUnitId: document.manuscript_unit_id,
        },
        correlationId: options.correlationId ?? null,
      });

      return { node: toResonanceNodeResponse(document) };
    },

    async update(admin, id, input, options = {}) {
      const node = await requireNode(id);
      const now = new Date();
      const set = { ...updateStamps(now) };

      if ('nodeType' in input) set.node_type = input.nodeType;
      if ('scores' in input) set.scores = input.scores;
      if ('chapter' in input) set.chapter = input.chapter;
      if ('section' in input) set.section = input.section;
      if ('summary' in input) set.summary = input.summary;

      const materialChange = 'nodeType' in input || 'scores' in input;
      if (materialChange && node.qa_status?.validated === true) {
        set.qa_status = { validated: false, validatedBy: null, validatedAt: null };
      }

      const updated = await nodes.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: RESONANCE_AUDIT_ACTIONS.UPDATE,
        targetCollection: COLLECTIONS.RESONANCE_NODES,
        targetId: id,
        before: { nodeType: node.node_type, validated: node.qa_status?.validated ?? null },
        after: { fields: Object.keys(set).filter((key) => key !== 'updatedAt') },
        correlationId: options.correlationId ?? null,
      });

      if (materialChange && node.qa_status?.validated === true) {
        logger?.info?.(
          { nodeId: node.node_id },
          'resonance node validation cleared by an edit; it needs signing again',
        );
      }

      return { node: toResonanceNodeResponse(updated) };
    },

    async validate(admin, id, input, options = {}) {
      const node = await requireNode(id);
      const now = new Date();
      const validated = input.validated === true;

      const updated = await nodes.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            qa_status: {
              validated,
              validatedBy: validated ? admin._id : null,
              validatedAt: validated ? now : null,
            },
            ...updateStamps(now),
          },
        },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: AUDIT_ACTIONS.RESONANCE_NODE_VALIDATE,
        targetCollection: COLLECTIONS.RESONANCE_NODES,
        targetId: id,
        before: { validated: node.qa_status?.validated ?? null },
        after: { validated, note: input.note ?? null },
        correlationId: options.correlationId ?? null,
      });

      return { node: toResonanceNodeResponse(updated) };
    },
  };
}

export default createAdminResonanceService;
