/**
 * Manuscript delivery — the reading path.
 *
 * Three laws govern this file.
 *
 * 1. **The public API hard-filters `branch === 'public'`.** The Confidential Development
 *    Edition is admin-only; leaking it is an unacceptable failure mode (§9.2.1, §9.7).
 * 2. **The rendering is chosen server-side from the *session's* `contentLayer`.** The client
 *    never names a layer. If it could, the youth renderings would be scrapeable by anyone
 *    who guessed the parameter (§9.3.1).
 * 3. **Releases never mutate.** A published unit is addressed by `contentVersion`; a change
 *    is a new version and therefore a new cache key. That is what makes
 *    `Cache-Control: public, max-age=31536000, immutable` honest (§9.7).
 *
 * **Content source.** The repository prefers the database: the canonical published
 * `public` manuscript and its published units. When no published unit exists — a fresh
 * checkout, a staging box that has never run the publish pipeline — it falls back to the
 * ingested release in `content/generated`, so the arc is servable immediately. Which source
 * is in use is logged once, clearly, at `info`; silently serving from a file when an
 * operator believes they are serving from the database would be a debugging trap.
 *
 * **Manifest granularity.** The manifest lists every addressable unit of the arc in locked
 * reading order — chapter-level units *and* their section-level children. Chapter units
 * carry the content notice and the `ChapterCompleted` identity; section units are the S10
 * render granularity (§3.4.2). A client renders the leaves (a `chapter` unit followed by
 * `section` units of the same chapter is a container, not a page) and uses the chapter row
 * for its notice and completion event.
 *
 * Reading-path failures degrade quietly: a unit that cannot be read from either source is a
 * calm 404, never a technical error surfaced to a reader.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CONTENT_LAYERS } from '../../config/constants.js';
import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

const GENERATED_DIR = fileURLToPath(new URL('../../../content/generated/', import.meta.url));
const GENERATED_RELEASE_PATH = `${GENERATED_DIR}release.json`;

/** The only certified layer today; also the fallback whenever a rendering is missing. */
export const DEFAULT_CONTENT_LAYER = 'full_manuscript';

/** Age layer → the `versions` key holding its approved rendering (§9.2.2). */
const LAYER_VERSION_KEYS = Object.freeze({
  foundation: 'age_8_12',
  awakening: 'age_13_16',
  transition: 'age_17_19',
  emerging_adult: 'age_20_25',
  grounded_adult: 'age_26_32',
  full_manuscript: 'age_33_plus',
});

/**
 * How long a resolved release is reused before the database is consulted again. Published
 * content changes at editorial pace, not reader pace.
 */
const RELEASE_CACHE_MS = 60_000;

/** Guards the generated-unit file read against anything that is not a known unit id. */
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* -------------------------------------------------------------------------- */
/* Generated-release loading (process-wide, immutable)                          */
/* -------------------------------------------------------------------------- */

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

/** Test seam: drop the process-wide generated-content cache. */
export function resetGeneratedContentCache() {
  generatedReleasePromise = null;
  generatedUnitPromises.clear();
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

function toIntegerOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Normalise one generated manifest row into the repository's internal unit shape.
 *
 * @param {object} entry A `release.json` unit entry.
 * @param {number} index Position in the locked reading order.
 * @returns {object} The internal unit meta.
 */
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

/**
 * Normalise one `manuscript_units` document. The collection stores the handoff's snake_case
 * field names; every surface above this line speaks camelCase.
 *
 * @param {object} document A `manuscript_units` document.
 * @param {number} index Position in the locked reading order.
 * @returns {object} The internal unit meta.
 */
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

/**
 * Build the immutable index a resolved release exposes.
 *
 * @param {{ source: string, releaseId: string, manuscriptVersion: string,
 *           contentHash: string|null, manuscriptId: string|null }} meta Release identity.
 * @param {object[]} units Normalised units, already in reading order.
 * @returns {object} The resolved release.
 */
function buildRelease(meta, units) {
  const byId = new Map();
  for (const unit of units) byId.set(unit.unitId, unit);

  // A no-share zone is inherited: §5.2 requires `is_no_share_zone` false on the current
  // unit *and all ancestors*.
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

/* -------------------------------------------------------------------------- */
/* Repository                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The content repository. One instance per Fastify module registration; the release index
 * is cached briefly, and generated files are cached for the life of the process because a
 * release is immutable by definition.
 *
 * @param {{ db: import('mongodb').Db, logger?: object }} deps Dependencies.
 * @returns {object} The repository.
 */
export function createContentRepository({ db, logger = null }) {
  if (!db) throw new TypeError('createContentRepository: a database handle is required.');

  let cached = null;
  let inFlight = null;
  let announcedSource = null;

  async function loadFromDatabase() {
    const manuscript = await db.collection(COLLECTIONS.MANUSCRIPTS).findOne(
      // The public API hard-filters the branch. This is the filter.
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

  /** Drop the resolved-release cache; the next read re-consults the database. */
  function invalidate() {
    cached = null;
  }

  /**
   * Resolve the blocks for one unit at one layer.
   *
   * @param {object} meta The unit meta.
   * @param {string} layer The requested content layer.
   * @param {object} release The resolved release.
   * @returns {Promise<{ blocks: object[], layer: string }>} The rendering.
   */
  async function loadBlocks(meta, layer, release) {
    if (release.source === 'generated') {
      const unit = await loadGeneratedUnit(meta.unitId);
      // The ingested release carries the canonical (`full_manuscript`) rendering only.
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

    // No approved rendering for this layer. Serving the canonical text is the correct
    // fallback: only `full_manuscript` is certified today, and a reader must never meet an
    // empty page because an editorial pipeline has not run.
    return { blocks: Array.isArray(document.blocks) ? document.blocks : [], layer: DEFAULT_CONTENT_LAYER };
  }

  return {
    invalidate,

    /** @returns {Promise<string>} `'database'` or `'generated'`. */
    async source() {
      return (await resolve()).source;
    },

    /**
     * The ordered manifest of an arc.
     *
     * @param {{ arc?: string }} [options] Arc selector; only `opening` exists in Phase 1.
     * @returns {Promise<object>} Release identity plus ordered unit rows.
     */
    async getManifest({ arc = 'opening' } = {}) {
      const release = await resolve();
      const units = release.units.filter((unit) => (arc === 'opening' ? unit.isOpeningArc : true));

      // A unit is read when nothing inside it is. Chapters 0, 00 and 1 are addressable
      // components that exist to anchor `ChapterCompleted` and the resonance map, but the
      // reader moves through their sections one at a time (§3.4.2). Everything else — the
      // front matter, the preludes, The Forgetting, the Foreword, the Introduction, the
      // Transition — has no children and is read whole.
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

    /**
     * One unit, rendered at the given layer.
     *
     * @param {string} unitId The unit identifier.
     * @param {{ layer?: string }} [options] The server-selected content layer.
     * @returns {Promise<object|null>} The §6 unit shape, or null when unknown.
     */
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

    /**
     * The protection facts a gate needs about one unit, plus the component identity a
     * passage anchor resolves against. Never reaches a reader — these are exactly the
     * editorial internals the response schemas exclude.
     *
     * @param {string} unitId The unit identifier.
     * @returns {Promise<object|null>} Unit facts, or null when unknown.
     */
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

    /**
     * @param {string} unitId Candidate identifier.
     * @returns {Promise<boolean>} True when the id names a unit of the governing release.
     */
    async hasUnit(unitId) {
      if (typeof unitId !== 'string') return false;
      const release = await resolve();
      return release.byId.has(unitId);
    },

    /** @returns {Promise<string|null>} The last unit in locked reading order. */
    async getFinalUnitId() {
      return (await resolve()).lastUnitId;
    },

    /**
     * The release a reader is being served. Stamped onto feedback so a passage anchor stays
     * meaningful after the next release: character offsets are only interpretable against
     * the text they were taken from.
     *
     * @returns {Promise<string|null>} The governing release identifier.
     */
    async getReleaseId() {
      return (await resolve()).releaseId ?? null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Layer selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Choose the content layer to serve. The client never participates in this decision.
 *
 * While `AGE_LAYER_ENABLED` is false the age screen does not exist and only
 * `full_manuscript` is certified, so every session is served the canonical rendering.
 *
 * @param {{ session: object|null, config: object }} input The session and configuration.
 * @returns {string} A member of `CONTENT_LAYERS`.
 */
export function resolveContentLayer({ session, config }) {
  if (!config?.flags?.ageLayerEnabled) return DEFAULT_CONTENT_LAYER;
  const layer = session?.contentLayer ?? null;
  return CONTENT_LAYERS.includes(layer) ? layer : DEFAULT_CONTENT_LAYER;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The route-facing manuscript service.
 *
 * @param {{ db: import('mongodb').Db, config: object, logger?: object,
 *           content?: object }} deps Dependencies.
 * @returns {object} The service.
 */
export function createManuscriptService({ db, config, logger = null, content = null }) {
  const repository = content ?? createContentRepository({ db, logger });

  return {
    content: repository,

    /**
     * @param {{ arc?: string }} query The manifest query.
     * @returns {Promise<object>} The manifest.
     */
    async manifest(query) {
      return repository.getManifest({ arc: query?.arc ?? 'opening' });
    },

    /**
     * @param {{ unitId: string, session: object }} input The request.
     * @returns {Promise<{ unit: object, etag: string }>} The unit and its cache validator.
     */
    async unit({ unitId, session }) {
      const layer = resolveContentLayer({ session, config });
      const unit = await repository.getUnit(unitId, { layer });
      if (!unit) {
        throw new ApiError(404, 'UNIT_NOT_FOUND', 'That passage is not part of this release.');
      }
      // The validator changes whenever the version or the served layer changes, so a reader
      // who switches experience depth is never handed a cached rendering of the other one.
      const fingerprint = unit.contentHash ?? `${unit.unitId}-${unit.contentVersion}`;
      return { unit, etag: `"${layer}-${unit.contentVersion}-${fingerprint}"` };
    },
  };
}

export default createManuscriptService;
