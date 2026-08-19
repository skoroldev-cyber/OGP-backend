/**
 * Manuscript route schemas.
 *
 * The response schemas here are the outbound filter for the reading path. Fastify
 * serialises only declared properties, so editorial internals — `is_no_share_zone`,
 * `eligible_for_resonance_mapping`, `emotional_metadata`, the source paragraph range, the
 * edition and branch labels — cannot escape through this surface even if a service returns
 * them by accident (BUILD_CONTRACT §4.2, master §9.3.1).
 *
 * `blocks[]` is the render contract of BUILD_CONTRACT §6 and the only renderable shape.
 * It is expressed as one closed object carrying the union of every block type's properties
 * rather than a `oneOf`: fast-json-stringify emits only the keys a given block actually
 * has, and a flat union keeps the schema free of the `$ref` recursion that a nested
 * `microstory` would otherwise require.
 */

import {
  CONTENT_ROLES,
  EMOTIONAL_TONES,
  UNIT_TYPES,
} from '../../config/constants.js';
import {
  arraySchema,
  boundedString,
  enumOf,
  errorResponses,
  identifier,
  nullableEnumOf,
  objectSchema,
  sessionTokenHeader,
} from '../../lib/schemas.js';

/** The seven renderable block shapes (BUILD_CONTRACT §6). */
export const BLOCK_TYPES = Object.freeze([
  'heading',
  'paragraph',
  'stanza',
  'epigraph',
  'microstory',
  'divider',
  'cue',
]);

/** Only the opening arc is servable in Phase 1. */
export const ARCS = Object.freeze(['opening']);

/* -------------------------------------------------------------------------- */
/* Render contract                                                             */
/* -------------------------------------------------------------------------- */

/** One styled span. `bold`/`italic` carry the founder's emphasis, recovered from the DOCX. */
const run = objectSchema(
  {
    text: boundedString(20_000),
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
  },
  { required: ['text'] },
);

/** One authored line inside a stanza or epigraph. Line breaks are semantic; never re-wrap. */
const line = objectSchema({
  runs: { type: 'array', maxItems: 400, items: run },
});

/** Properties shared by every block, and by the blocks nested inside a microstory. */
const blockProperties = Object.freeze({
  type: enumOf(BLOCK_TYPES),
  level: { type: 'integer', minimum: 1, maximum: 3 },
  text: boundedString(4000),
  runs: { type: 'array', maxItems: 400, items: run },
  lines: { type: 'array', maxItems: 800, items: line },
  attribution: boundedString(400),
});

/** A block inside a microstory. Microstories do not nest, so this shape terminates. */
const nestedBlock = objectSchema({ ...blockProperties }, { required: ['type'] });

/** A top-level block. */
const block = objectSchema(
  {
    ...blockProperties,
    title: boundedString(400),
    blocks: { type: 'array', maxItems: 400, items: nestedBlock },
  },
  { required: ['type'] },
);

/**
 * The longest unit in the governing release carries 335 blocks; the cap is generous
 * headroom rather than a limit anything real approaches.
 */
const blocks = Object.freeze({ type: 'array', maxItems: 4000, items: block });

/* -------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One manifest row — BUILD_CONTRACT §4.2 exactly. No text, no editorial flags.
 *
 * The array itself carries the ordering: `units[]` is in the locked reading order of
 * §3.5.2. `sequenceIndex` is the authored spine index and is deliberately *not* unique
 * across section-level units of the same chapter, so array position is authoritative.
 */
const manifestUnit = objectSchema(
  {
    unitId: identifier,
    parentUnitId: { type: ['string', 'null'], maxLength: 128 },
    unitType: enumOf(UNIT_TYPES),
    sequenceIndex: { type: 'integer' },
    /** Which of the twelve protected components this unit belongs to (§3.5.2). */
    componentIndex: { type: ['integer', 'null'] },
    /**
     * True when this unit is one the reader actually reads.
     *
     * The release carries both the chapter-level components and the section-level units they
     * contain, because the components are the addressable spine (`ChapterCompleted` is emitted
     * per component) while the sections are the render granularity (§3.4.2: "One section-level
     * unit renders at a time"). A client that walked every row would render Chapter 0 once as a
     * chapter and then again as eight sections. This flag is the spine: render the units where
     * it is true, in array order, and the arc reads exactly once.
     */
    isReadingUnit: { type: 'boolean' },
    canonicalTitle: { type: ['string', 'null'], maxLength: 400 },
    chapterNumber: { type: ['integer', 'null'] },
    sectionNumber: { type: ['integer', 'null'] },
    wordCount: { type: ['integer', 'null'] },
    contentVersion: { type: 'integer' },
    isHighImpact: { type: 'boolean' },
    requiresDecompressionAfter: { type: 'boolean' },
    contentNoticeKey: { type: ['string', 'null'], maxLength: 64 },
  },
  {
    required: [
      'unitId',
      'parentUnitId',
      'unitType',
      'sequenceIndex',
      'componentIndex',
      'isReadingUnit',
      'canonicalTitle',
      'chapterNumber',
      'sectionNumber',
      'wordCount',
      'contentVersion',
      'isHighImpact',
      'requiresDecompressionAfter',
      'contentNoticeKey',
    ],
  },
);

export const manifestQuery = objectSchema({
  arc: { type: 'string', enum: [...ARCS], default: 'opening' },
});

export const manifestResponse = objectSchema(
  {
    releaseId: boundedString(64),
    manuscriptVersion: boundedString(32),
    contentHash: { type: ['string', 'null'], maxLength: 128 },
    units: arraySchema(manifestUnit, { maxItems: 2000 }),
  },
  { required: ['releaseId', 'manuscriptVersion', 'contentHash', 'units'] },
);

/* -------------------------------------------------------------------------- */
/* Unit                                                                        */
/* -------------------------------------------------------------------------- */

export const unitParams = objectSchema(
  { unitId: identifier },
  { required: ['unitId'] },
);

export const unitHeaders = Object.freeze({
  type: 'object',
  properties: {
    ...sessionTokenHeader.properties,
    'if-none-match': { type: 'string', maxLength: 256 },
  },
});

/** BUILD_CONTRACT §6, wrapped per master §9.3.1 (`→ 200 { unit }`). */
export const unitResponse = objectSchema(
  {
    unit: objectSchema(
      {
        unitId: identifier,
        releaseId: boundedString(64),
        unitType: enumOf(UNIT_TYPES),
        sequenceIndex: { type: 'integer' },
        componentIndex: { type: ['integer', 'null'] },
        chapterNumber: { type: ['integer', 'null'] },
        sectionNumber: { type: ['integer', 'null'] },
        canonicalTitle: { type: ['string', 'null'], maxLength: 400 },
        contentRole: nullableEnumOf(CONTENT_ROLES),
        emotionalTone: nullableEnumOf(EMOTIONAL_TONES),
        wordCount: { type: ['integer', 'null'] },
        isOpeningArc: { type: 'boolean' },
        isHighImpact: { type: 'boolean' },
        requiresDecompressionAfter: { type: 'boolean' },
        contentNoticeKey: { type: ['string', 'null'], maxLength: 64 },
        contentVersion: { type: 'integer' },
        contentHash: { type: ['string', 'null'], maxLength: 128 },
        blocks,
      },
      {
        required: [
          'unitId',
          'releaseId',
          'unitType',
          'sequenceIndex',
          'canonicalTitle',
          'isOpeningArc',
          'isHighImpact',
          'requiresDecompressionAfter',
          'contentVersion',
          'blocks',
        ],
      },
    ),
  },
  { required: ['unit'] },
);

/** `304 Not Modified` carries no body. */
export const notModifiedResponse = Object.freeze({ type: 'null' });

export const manuscriptErrorResponses = errorResponses(400, 401, 404, 429, 500, 503);

