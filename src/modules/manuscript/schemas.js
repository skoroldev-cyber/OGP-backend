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

export const BLOCK_TYPES = Object.freeze([
  'heading',
  'paragraph',
  'stanza',
  'epigraph',
  'microstory',
  'divider',
  'cue',
]);

export const ARCS = Object.freeze(['opening']);

const run = objectSchema(
  {
    text: boundedString(20_000),
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
  },
  { required: ['text'] },
);

const line = objectSchema({
  runs: { type: 'array', maxItems: 400, items: run },
});

const blockProperties = Object.freeze({
  type: enumOf(BLOCK_TYPES),
  level: { type: 'integer', minimum: 1, maximum: 3 },
  text: boundedString(4000),
  runs: { type: 'array', maxItems: 400, items: run },
  lines: { type: 'array', maxItems: 800, items: line },
  attribution: boundedString(400),
});

const nestedBlock = objectSchema({ ...blockProperties }, { required: ['type'] });

const block = objectSchema(
  {
    ...blockProperties,
    title: boundedString(400),
    blocks: { type: 'array', maxItems: 400, items: nestedBlock },
  },
  { required: ['type'] },
);

const blocks = Object.freeze({ type: 'array', maxItems: 4000, items: block });

const manifestUnit = objectSchema(
  {
    unitId: identifier,
    parentUnitId: { type: ['string', 'null'], maxLength: 128 },
    unitType: enumOf(UNIT_TYPES),
    sequenceIndex: { type: 'integer' },
    componentIndex: { type: ['integer', 'null'] },
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

export const notModifiedResponse = Object.freeze({ type: 'null' });

export const manuscriptErrorResponses = errorResponses(400, 401, 404, 429, 500, 503);

