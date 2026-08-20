import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CONTENT_LAYERS } from '../../config/constants.js';
import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

const GENERATED_DIR = fileURLToPath(new URL('../../../content/generated/', import.meta.url));
const GENERATED_RELEASE_PATH = `${GENERATED_DIR}release.json`;

export const DEFAULT_CONTENT_LAYER = 'full_manuscript';

const LAYER_VERSION_KEYS = Object.freeze({
  foundation: 'age_8_12',
  awakening: 'age_13_16',
  transition: 'age_17_19',
  emerging_adult: 'age_20_25',
  grounded_adult: 'age_26_32',
  full_manuscript: 'age_33_plus',
});

const RELEASE_CACHE_MS = 60_000;

const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let generatedReleasePromise = null;
const generatedUnitPromises = new Map();

function loadGeneratedRelease() {
  generatedReleasePromise ??= readFile(GENERATED_RELEASE_PATH, 'utf8').then((raw) =>
    JSON.parse(raw),
  );
  return generatedReleasePromise;
}

function loadGeneratedUnit(unitId) {
  let pending = generatedUnitPromises.get(unitId);
  if (!pending) {
    pending = readFile(`${GENERATED_DIR}units/${unitId}.json`, 'utf8').then((raw) =>
      JSON.parse(raw),
    );
    generatedUnitPromises.set(unitId, pending);
  }
  return pending;
}

export function resetGeneratedContentCache() {
  generatedReleasePromise = null;
  generatedUnitPromises.clear();
}

function toIntegerOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function metaFromGenerated(entry, index) {
  return {
    unitId: entry.unitId,
    parentUnitId: entry.parentUnitId ?? null,
    unitType: entry.unitType,
    sequenceIndex: toIntegerOrNull(entry.sequenceIndex) ?? index,
    readingOrder: toIntegerOrNull(entry.readingOrder) ?? index,
    componentIndex: toIntegerOrNull(entry.componentIndex),
    chapterNumber: toIntegerOrNull(entry.chapterNumber),
    sectionNumber: toIntegerOrNull(entry.sectionNumber),
    canonicalTitle: entry.canonicalTitle ?? null,
    contentRole: entry.contentRole ?? null,
    emotionalTone: entry.emotionalTone ?? null,
    wordCount: toIntegerOrNull(entry.wordCount),
    isOpeningArc: entry.isOpeningArc === true,
    isHighImpact: entry.isHighImpact === true,
    isNoShareZone: entry.isNoShareZone === true,
    requiresDecompressionAfter: entry.requiresDecompressionAfter === true,
    contentNoticeKey: entry.contentNoticeKey ?? null,
    contentVersion: toIntegerOrNull(entry.contentVersion) ?? 1,
    contentHash: entry.contentHash ?? null,
  };
}

function metaFromDatabase(document, index) {
  return {
    unitId: document.unitId,
    parentUnitId: document.parent_unit_id ?? null,
    unitType: document.unit_type,
    sequenceIndex: toIntegerOrNull(document.sequence_index) ?? index,
    readingOrder: index,
    componentIndex: toIntegerOrNull(document.componentIndex),
    chapterNumber: toIntegerOrNull(document.chapter_number),
    sectionNumber: toIntegerOrNull(document.section_number),
    canonicalTitle: document.canonical_title ?? null,
    contentRole: document.content_role ?? null,
    emotionalTone: document.emotional_tone ?? null,
    wordCount: toIntegerOrNull(document.word_count),
    isOpeningArc: document.is_opening_arc === true,
    isHighImpact: document.is_high_impact === true,
    isNoShareZone: document.is_no_share_zone === true,
    requiresDecompressionAfter: document.requires_decompression_after === true,
    contentNoticeKey: document.contentNoticeKey ?? null,
    contentVersion: toIntegerOrNull(document.contentVersion) ?? 1,
    contentHash: document.contentHash ?? null,
  };
}

function buildRelease(meta, units) {
  const byId = new Map();
  for (const unit of units) byId.set(unit.unitId, unit);

  for (const unit of units) {
    let inherited = unit.isNoShareZone;
    let cursor = unit.parentUnitId;
    const seen = new Set([unit.unitId]);
    while (!inherited && cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      inherited = parent.isNoShareZone;
      cursor = parent.parentUnitId;
    }
    unit.isNoShareZoneInherited = inherited;
  }

  return Object.freeze({
    ...meta,
    units,
    byId,
    lastUnitId: units.length > 0 ? units[units.length - 1].unitId : null,
  });
}

export function createContentRepository({ db, logger = null }) {
  if (!db) throw new TypeError('createContentRepository: a database handle is required.');

  let cached = null;
  let inFlight = null;
  let announcedSource = null;

  async function loadFromDatabase() {
    const manuscript = await db.collection(COLLECTIONS.MANUSCRIPTS).findOne(
      { branch: 'public', status: 'published' },
      { sort: { isCanonical: -1, updatedAt: -1 } },
    );
    if (!manuscript) return null;

    const documents = await db
      .collection(COLLECTIONS.MANUSCRIPT_UNITS)
      .find(
        { manuscriptId: manuscript._id, status: 'published', is_opening_arc: true },
        {
          sort: { sequence_index: 1 },
          projection: { canonicalText: 0, versions: 0, blocks: 0 },
        },
      )
      .toArray();
    if (documents.length === 0) return null;

    return buildRelease(
      {
        source: 'database',
        manuscriptId: manuscript._id,
        releaseId: manuscript.releaseId ?? manuscript._id,
        manuscriptVersion: manuscript.version ?? '1.0',
        contentHash: manuscript.contentHash ?? null,
      },
      documents.map(metaFromDatabase),
    );
  }

  async function loadFromGenerated() {
    const release = await loadGeneratedRelease();
    const entries = Array.isArray(release.units) ? [...release.units] : [];
    entries.sort((a, b) => (a.readingOrder ?? 0) - (b.readingOrder ?? 0));
    return buildRelease(
      {
        source: 'generated',
        manuscriptId: null,
        releaseId: release.releaseId,
        manuscriptVersion: release.manuscriptVersion ?? '1.0',
        contentHash: release.contentHash ?? null,
      },
      entries.map(metaFromGenerated),
    );
  }

  function announce(release) {
    if (announcedSource === release.source || !logger?.info) return;
    announcedSource = release.source;
    if (release.source === 'database') {
      logger.info(
        { source: 'database', releaseId: release.releaseId, units: release.units.length },
        'manuscript served from published database units',
      );
    } else {
      logger.info(
        { source: 'content/generated', releaseId: release.releaseId, units: release.units.length },
        'no published manuscript unit found — manuscript served from the ingested release in content/generated',
      );
    }
  }

  async function resolve() {
    const now = Date.now();
    if (cached && now - cached.at < RELEASE_CACHE_MS) return cached.release;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let release = null;
      try {
        release = await loadFromDatabase();
      } catch (error) {
        logger?.warn?.({ err: error }, 'published manuscript lookup failed; falling back to the ingested release');
      }
      if (!release) release = await loadFromGenerated();
      announce(release);
      cached = { at: Date.now(), release };
      return release;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function invalidate() {
    cached = null;
  }

  async function loadBlocks(meta, layer, release) {
    if (release.source === 'generated') {
      const unit = await loadGeneratedUnit(meta.unitId);
      return { blocks: Array.isArray(unit.blocks) ? unit.blocks : [], layer: DEFAULT_CONTENT_LAYER };
    }

    const document = await db.collection(COLLECTIONS.MANUSCRIPT_UNITS).findOne(
      { unitId: meta.unitId, manuscriptId: release.manuscriptId, status: 'published' },
      { projection: { blocks: 1, versions: 1 } },
    );
    if (!document) return { blocks: [], layer: DEFAULT_CONTENT_LAYER };

    const versionKey = LAYER_VERSION_KEYS[layer] ?? null;
    const rendering = versionKey ? document.versions?.[versionKey] ?? null : null;
    const approved =
      rendering &&
      ['approved', 'published'].includes(rendering.status) &&
      Array.isArray(rendering.blocks) &&
      rendering.blocks.length > 0;

    if (approved) return { blocks: rendering.blocks, layer };

    return { blocks: Array.isArray(document.blocks) ? document.blocks : [], layer: DEFAULT_CONTENT_LAYER };
  }

  return {
    invalidate,

    async source() {
      return (await resolve()).source;
    },

    async getManifest({ arc = 'opening' } = {}) {
      const release = await resolve();
      const units = release.units.filter((unit) => (arc === 'opening' ? unit.isOpeningArc : true));

      const parentIds = new Set(units.map((unit) => unit.parentUnitId).filter(Boolean));

      return {
        releaseId: release.releaseId,
        manuscriptVersion: release.manuscriptVersion,
        contentHash: release.contentHash,
        units: units.map((unit) => ({
          unitId: unit.unitId,
          parentUnitId: unit.parentUnitId ?? null,
          unitType: unit.unitType,
          sequenceIndex: unit.sequenceIndex,
          componentIndex: unit.componentIndex ?? null,
          isReadingUnit: !parentIds.has(unit.unitId),
          canonicalTitle: unit.canonicalTitle,
          chapterNumber: unit.chapterNumber,
          sectionNumber: unit.sectionNumber,
          wordCount: unit.wordCount,
          contentVersion: unit.contentVersion,
          isHighImpact: unit.isHighImpact,
          requiresDecompressionAfter: unit.requiresDecompressionAfter,
          contentNoticeKey: unit.contentNoticeKey,
        })),
      };
    },

    async getUnit(unitId, { layer = DEFAULT_CONTENT_LAYER } = {}) {
      if (typeof unitId !== 'string' || !UNIT_ID_PATTERN.test(unitId)) return null;
      const release = await resolve();
      const meta = release.byId.get(unitId);
      if (!meta) return null;

      const { blocks } = await loadBlocks(meta, layer, release);

      return {
        unitId: meta.unitId,
        releaseId: release.releaseId,
        unitType: meta.unitType,
        sequenceIndex: meta.sequenceIndex,
        componentIndex: meta.componentIndex,
        chapterNumber: meta.chapterNumber,
        sectionNumber: meta.sectionNumber,
        canonicalTitle: meta.canonicalTitle,
        contentRole: meta.contentRole,
        emotionalTone: meta.emotionalTone,
        wordCount: meta.wordCount,
        isOpeningArc: meta.isOpeningArc,
        isHighImpact: meta.isHighImpact,
        requiresDecompressionAfter: meta.requiresDecompressionAfter,
        contentNoticeKey: meta.contentNoticeKey,
        contentVersion: meta.contentVersion,
        contentHash: meta.contentHash,
        blocks,
      };
    },

    async getUnitFacts(unitId) {
      if (typeof unitId !== 'string') return null;
      const release = await resolve();
      const meta = release.byId.get(unitId);
      if (!meta) return null;
      return {
        unitId: meta.unitId,
        parentUnitId: meta.parentUnitId,
        unitType: meta.unitType,
        componentIndex: meta.componentIndex,
        chapterNumber: meta.chapterNumber,
        sectionNumber: meta.sectionNumber,
        contentRole: meta.contentRole,
        isNoShareZone: meta.isNoShareZone,
        isNoShareZoneInherited: meta.isNoShareZoneInherited === true,
        isHighImpact: meta.isHighImpact,
        requiresDecompressionAfter: meta.requiresDecompressionAfter,
        isFinalUnit: meta.unitId === release.lastUnitId,
      };
    },

    async hasUnit(unitId) {
      if (typeof unitId !== 'string') return false;
      const release = await resolve();
      return release.byId.has(unitId);
    },

    async getFinalUnitId() {
      return (await resolve()).lastUnitId;
    },

    async getReleaseId() {
      return (await resolve()).releaseId ?? null;
    },
  };
}

export function resolveContentLayer({ session, config }) {
  if (!config?.flags?.ageLayerEnabled) return DEFAULT_CONTENT_LAYER;
  const layer = session?.contentLayer ?? null;
  return CONTENT_LAYERS.includes(layer) ? layer : DEFAULT_CONTENT_LAYER;
}

export function createManuscriptService({ db, config, logger = null, content = null }) {
  const repository = content ?? createContentRepository({ db, logger });

  return {
    content: repository,

    async manifest(query) {
      return repository.getManifest({ arc: query?.arc ?? 'opening' });
    },

    async unit({ unitId, session }) {
      const layer = resolveContentLayer({ session, config });
      const unit = await repository.getUnit(unitId, { layer });
      if (!unit) {
        throw new ApiError(404, 'UNIT_NOT_FOUND', 'That passage is not part of this release.');
      }
      const fingerprint = unit.contentHash ?? `${unit.unitId}-${unit.contentVersion}`;
      return { unit, etag: `"${layer}-${unit.contentVersion}-${fingerprint}"` };
    },
  };
}

export default createManuscriptService;
