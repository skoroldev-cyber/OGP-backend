#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractDocumentXml, parseParagraphs } from './lib/docx.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

const RELEASE = {
  releaseId: 'REL-NONO-BRE-20260803-V1',
  workId: 'WORK-NOW-OR-NEVER-ONE',
  edition: 'beta_reader_v2_0',
  branch: 'public',
  manuscriptVersion: 'v2.0',
  arc: 'opening',
  contentLayer: 'full_manuscript',
  contentVersion: 1,
};

const UNIT_ID_PREFIX = 'CU-NONO-OA';
const DEFAULT_SOURCE = path.join(
  REPO_ROOT,
  'portfolio-itom-main',
  'Technical Document',
  'OGP_Opening_Arc_Beta_Reader_Edition_v2_0.docx',
);
const DEFAULT_OUT_DIR = path.join(BACKEND_ROOT, 'content', 'generated');

const COMPONENT_HEADING_LEVEL = 1;
const SECTION_HEADING_LEVEL = 2;
const MICROSTORY_HEADING_LEVEL = 3;
const STANZA_MAX_WORDS = 12;
const STANZA_MIN_LINES = 2;
const EPIGRAPH_MAX_PARAGRAPHS = 6;

const MICROSTORY_TITLE_PATTERN = /^micro-?story\b/i;
const DIVIDER_PATTERN = /^(?:-{3,}|\*{3,})$/;
const OPEN_QUOTE_PATTERN = /^["“‘«]/;
const CLOSE_QUOTE_PATTERN = /["”’»]\s*$/;
const ATTRIBUTION_PATTERN = /[—–]\s*One\s*$/;
const ATTRIBUTION_SUFFIX_PATTERN = /\s*[—–]\s*One\s*$/;
const TERMINAL_COLON_PATTERN = /:\s*$/;
const EPIGRAPH_ATTRIBUTION = '— One';

const CUE_PREFIXES = ['Turn the page.', 'Take a breath. Then turn the page.'];

const SECTION_NUMBER_PATTERNS = [/^Section\s+(\d+)\b/i, /^(\d+)\s*[.)]/];

const COMPONENT_PLAN = [
  {
    componentIndex: 0,
    expectedTitle: null,
    fallbackTitle: 'Title and Copyright',
    unitType: 'front_matter',
    contentRole: 'orientation',
    emotionalTone: 'calm',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 61,
  },
  {
    componentIndex: 1,
    expectedTitle: 'Two Predators',
    unitType: 'passage',
    contentRole: 'exposure',
    emotionalTone: 'grave',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 478,
  },
  {
    componentIndex: 2,
    expectedTitle: 'Preface to Chapter 0 — The 1%: Money, Power, and Influence',
    unitType: 'passage',
    contentRole: 'orientation',
    emotionalTone: 'clarifying',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 448,
  },
  {
    componentIndex: 3,
    expectedTitle: 'CHAPTER 0 — THE 1%: MONEY, POWER, AND INFLUENCE',
    unitType: 'chapter',
    contentRole: 'exposure',
    emotionalTone: 'grave',
    chapterNumber: 0,
    chapterLabel: '0',
    hasSections: true,
    expectedSectionCount: 8,
    expectedWordCount: 2229,
  },
  {
    componentIndex: 4,
    expectedTitle: 'CHAPTER 00 — THE OPERATING SYSTEM BEHIND POWER',
    unitType: 'chapter',
    contentRole: 'exposure',
    emotionalTone: 'intense',
    chapterNumber: -1,
    chapterLabel: '00',
    hasSections: true,
    expectedSectionCount: 9,
    expectedWordCount: 2103,
  },
  {
    componentIndex: 5,
    expectedTitle: 'PRELUDE I — EARTH MOTHER SPEAKS',
    unitType: 'passage',
    contentRole: 'recognition',
    emotionalTone: 'tender',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 293,
  },
  {
    componentIndex: 6,
    expectedTitle: 'PRELUDE II — THE VOICE OF HUMANITY (ONE)',
    unitType: 'passage',
    contentRole: 'recognition',
    emotionalTone: 'tender',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 283,
  },
  {
    componentIndex: 7,
    expectedTitle: 'THE FORGETTING',
    unitType: 'passage',
    contentRole: 'recognition',
    emotionalTone: 'reflective',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 522,
  },
  {
    componentIndex: 8,
    expectedTitle: 'CHAPTER 1 — RELATIONSHIP',
    unitType: 'chapter',
    contentRole: 'exposure',
    emotionalTone: 'grave',
    chapterNumber: 1,
    chapterLabel: '1',
    hasSections: true,
    expectedSectionCount: 8,
    contentNoticeKey: 'CONTENT_NOTICE_CH1',
    expectedWordCount: 7247,
  },
  {
    componentIndex: 9,
    expectedTitle: 'FOREWORD',
    unitType: 'front_matter',
    contentRole: 'orientation',
    emotionalTone: 'clarifying',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 778,
  },
  {
    componentIndex: 10,
    expectedTitle: 'INTRODUCTION — A LETTER TO THE READER',
    unitType: 'front_matter',
    contentRole: 'orientation',
    emotionalTone: 'clarifying',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 934,
  },
  {
    componentIndex: 11,
    expectedTitle: 'Transition to Chapter 2 — Awareness',
    unitType: 'transition',
    contentRole: 'transition',
    emotionalTone: 'convergent',
    chapterNumber: null,
    chapterLabel: null,
    hasSections: false,
    expectedWordCount: 164,
  },
];

const SECTION_METADATA = {
  'CU-NONO-OA-003-S07': { contentRole: 'recognition', emotionalTone: 'reflective' },
  'CU-NONO-OA-003-S08': { contentRole: 'orientation', emotionalTone: 'clarifying' },

  'CU-NONO-OA-004-S02': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S03': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S04': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S05': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S06': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S07': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S09': { contentRole: 'invitation', emotionalTone: 'convergent' },

  'CU-NONO-OA-008-S01': { contentRole: 'recognition', emotionalTone: 'reflective' },
  'CU-NONO-OA-008-S04': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S05': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S06': { emotionalTone: 'reflective' },
  'CU-NONO-OA-008-S07': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S08': { isHighImpact: true, contentRole: 'convergence', emotionalTone: 'convergent' },
};

const DEFAULT_SECTION_CONTENT_ROLE = 'exposure';

function countWords(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function titleKey(text) {
  return text
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function sha256Bytes(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function cloneLines(lines) {
  return lines.map((line) => ({ runs: line.runs.map((run) => ({ ...run })) }));
}

function flattenRuns(paragraph) {
  return cloneLines(paragraph.lines).flatMap((line) => line.runs);
}

function isCue(paragraph) {
  return CUE_PREFIXES.some((prefix) => paragraph.text.trim().startsWith(prefix));
}

function isBreathParagraph(paragraph) {
  const lines = paragraph.text.split('\n');
  if (lines.some((line) => countWords(line) > STANZA_MAX_WORDS)) return false;
  return !TERMINAL_COLON_PATTERN.test(paragraph.text);
}

function stripAttribution(lines) {
  const last = lines[lines.length - 1];
  for (let index = last.runs.length - 1; index >= 0; index -= 1) {
    const run = last.runs[index];
    const stripped = run.text.replace(ATTRIBUTION_SUFFIX_PATTERN, '');
    if (stripped !== run.text) {
      run.text = stripped.replace(/\s+$/, '');
      break;
    }
  }
  last.runs = last.runs.filter((run) => run.text !== '');
}

function matchEpigraph(paragraphs, start) {
  const first = paragraphs[start];
  if (!OPEN_QUOTE_PATTERN.test(first.text.trim())) return null;

  const limit = Math.min(start + EPIGRAPH_MAX_PARAGRAPHS, paragraphs.length);
  for (let index = start; index < limit; index += 1) {
    const candidate = paragraphs[index];
    if (index > start && (candidate.level > 0 || candidate.isEmpty)) return null;

    const text = candidate.text.trim();
    if (ATTRIBUTION_PATTERN.test(text)) {
      const lines = paragraphs
        .slice(start, index + 1)
        .flatMap((paragraph) => cloneLines(paragraph.lines));
      stripAttribution(lines);
      return {
        block: { type: 'epigraph', lines, attribution: EPIGRAPH_ATTRIBUTION },
        nextIndex: index + 1,
      };
    }
    if (CLOSE_QUOTE_PATTERN.test(text)) return null;
  }
  return null;
}

function findHeadingBoundary(paragraphs, start, level) {
  for (let index = start; index < paragraphs.length; index += 1) {
    if (paragraphs[index].level > 0 && paragraphs[index].level <= level) return index;
  }
  return paragraphs.length;
}

function classifyBlocks(paragraphs) {
  const blocks = [];
  let breathBuffer = [];

  const flushBreathBuffer = () => {
    if (breathBuffer.length === 0) return;
    const lines = breathBuffer.flatMap((paragraph) => cloneLines(paragraph.lines));
    if (breathBuffer.length < STANZA_MIN_LINES && lines.length < STANZA_MIN_LINES) {
      blocks.push({ type: 'paragraph', runs: lines[0].runs });
    } else {
      blocks.push({ type: 'stanza', lines });
    }
    breathBuffer = [];
  };

  let index = 0;
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index];

    if (paragraph.isEmpty) {
      flushBreathBuffer();
      index += 1;
      continue;
    }

    if (paragraph.level > 0) {
      flushBreathBuffer();
      if (
        paragraph.level === MICROSTORY_HEADING_LEVEL &&
        MICROSTORY_TITLE_PATTERN.test(paragraph.text.trim())
      ) {
        const end = findHeadingBoundary(paragraphs, index + 1, paragraph.level);
        blocks.push({
          type: 'microstory',
          title: paragraph.text,
          blocks: classifyBlocks(paragraphs.slice(index + 1, end)),
        });
        index = end;
      } else {
        blocks.push({ type: 'heading', level: paragraph.level, text: paragraph.text });
        index += 1;
      }
      continue;
    }

    if (DIVIDER_PATTERN.test(paragraph.text.trim())) {
      flushBreathBuffer();
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }

    const epigraph = matchEpigraph(paragraphs, index);
    if (epigraph) {
      flushBreathBuffer();
      blocks.push(epigraph.block);
      index = epigraph.nextIndex;
      continue;
    }

    if (isCue(paragraph)) {
      flushBreathBuffer();
      blocks.push({ type: 'cue', runs: flattenRuns(paragraph) });
      index += 1;
      continue;
    }

    if (isBreathParagraph(paragraph)) {
      breathBuffer.push(paragraph);
      index += 1;
      continue;
    }

    flushBreathBuffer();
    const lines = cloneLines(paragraph.lines);
    blocks.push(
      lines.length > 1 ? { type: 'stanza', lines } : { type: 'paragraph', runs: lines[0].runs },
    );
    index += 1;
  }

  flushBreathBuffer();
  return blocks;
}

function countBlockTypes(blocks, into = {}) {
  for (const block of blocks) {
    into[block.type] = (into[block.type] ?? 0) + 1;
    if (block.type === 'microstory') countBlockTypes(block.blocks, into);
  }
  return into;
}

function componentUnitId(componentIndex) {
  return `${UNIT_ID_PREFIX}-${String(componentIndex).padStart(3, '0')}`;
}

function sectionUnitId(componentIndex, sectionOrdinal) {
  return `${componentUnitId(componentIndex)}-S${String(sectionOrdinal).padStart(2, '0')}`;
}

function readSectionNumber(text, ordinal) {
  for (const pattern of SECTION_NUMBER_PATTERNS) {
    const match = text.trim().match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return ordinal;
}

function segmentComponents(paragraphs) {
  const headingIndexes = paragraphs
    .filter((paragraph) => paragraph.level === COMPONENT_HEADING_LEVEL)
    .map((paragraph) => paragraph.index);

  const starts = headingIndexes[0] === 0 ? headingIndexes : [0, ...headingIndexes];
  return starts.map((start, position) => ({
    start,
    end: position + 1 < starts.length ? starts[position + 1] : paragraphs.length,
    heading: paragraphs[start].level === COMPONENT_HEADING_LEVEL ? paragraphs[start] : null,
  }));
}

function segmentSections(slice) {
  const starts = slice
    .map((paragraph, position) => (paragraph.level === SECTION_HEADING_LEVEL ? position : -1))
    .filter((position) => position !== -1);

  if (starts.length === 0) return [];

  const spans = starts.map((start, position) => ({
    start,
    end: position + 1 < starts.length ? starts[position + 1] : slice.length,
    heading: slice[start],
    isOpening: false,
  }));

  if (starts[0] > 0) {
    spans.unshift({ start: 0, end: starts[0], heading: null, isOpening: true });
  }

  return spans;
}

function buildUnits(paragraphs) {
  const spans = segmentComponents(paragraphs);
  const problems = [];

  if (spans.length !== COMPONENT_PLAN.length) {
    problems.push(
      `LOCKED SEQUENCE: expected ${COMPONENT_PLAN.length} protected components, derived ${spans.length}.`,
    );
  }

  const units = [];
  let readingOrder = 0;

  spans.forEach((span, position) => {
    const plan = COMPONENT_PLAN[position];
    if (!plan) {
      problems.push(`LOCKED SEQUENCE: unplanned component at paragraph ${span.start}.`);
      return;
    }

    const authoredTitle = span.heading ? span.heading.text : null;
    if (plan.expectedTitle && titleKey(authoredTitle ?? '') !== titleKey(plan.expectedTitle)) {
      problems.push(
        `LOCKED SEQUENCE: component ${plan.componentIndex} expected "${plan.expectedTitle}", derived "${authoredTitle}".`,
      );
    }
    if (!plan.expectedTitle && span.heading) {
      problems.push(`LOCKED SEQUENCE: component ${plan.componentIndex} should carry no heading.`);
    }

    const slice = paragraphs.slice(span.start, span.end);
    const wordCount = slice.reduce((total, paragraph) => total + countWords(paragraph.text), 0);
    const unitId = componentUnitId(plan.componentIndex);
    const blocks = classifyBlocks(slice);

    const sectionSpans = plan.hasSections ? segmentSections(slice) : [];
    const numberedSpanCount = sectionSpans.filter((span) => !span.isOpening).length;
    if (plan.expectedSectionCount && numberedSpanCount !== plan.expectedSectionCount) {
      problems.push(
        `SECTIONS: component ${plan.componentIndex} expected ${plan.expectedSectionCount} sections, derived ${numberedSpanCount}.`,
      );
    }

    let numberedSoFar = 0;
    const sections = sectionSpans.map((sectionSpan) => {
      const ordinal = sectionSpan.isOpening ? 0 : (numberedSoFar += 1);
      const sectionId = sectionUnitId(plan.componentIndex, ordinal);
      const overrides = SECTION_METADATA[sectionId] ?? {};
      const sectionSlice = slice.slice(sectionSpan.start, sectionSpan.end);
      const sectionBlocks = classifyBlocks(sectionSlice);

      return {
        unitId: sectionId,
        parentUnitId: unitId,
        unitType: 'section',
        componentIndex: plan.componentIndex,
        chapterNumber: plan.chapterNumber,
        chapterLabel: plan.chapterLabel,
        sectionNumber: sectionSpan.isOpening
          ? null
          : readSectionNumber(sectionSpan.heading.text, ordinal),
        sectionOrdinal: ordinal,
        canonicalTitle: sectionSpan.isOpening ? authoredTitle : sectionSpan.heading.text,
        contentRole: overrides.contentRole ?? DEFAULT_SECTION_CONTENT_ROLE,
        emotionalTone: overrides.emotionalTone ?? plan.emotionalTone,
        wordCount: sectionSlice.reduce((total, paragraph) => total + countWords(paragraph.text), 0),
        isOpeningArc: true,
        isHighImpact: overrides.isHighImpact === true,
        isNoShareZone: overrides.isNoShareZone === true,
        requiresDecompressionAfter: overrides.requiresDecompressionAfter === true,
        eligibleForResonanceMapping: true,
        contentNoticeKey: null,
        sourceParagraphRange: {
          start: sectionSlice[0].index,
          end: sectionSlice[sectionSlice.length - 1].index,
        },
        blocks: sectionBlocks,
      };
    });

    const component = {
      unitId,
      parentUnitId: null,
      unitType: plan.unitType,
      componentIndex: plan.componentIndex,
      chapterNumber: plan.chapterNumber,
      chapterLabel: plan.chapterLabel,
      sectionNumber: null,
      sectionOrdinal: null,
      canonicalTitle: authoredTitle ?? plan.fallbackTitle,
      contentRole: plan.contentRole,
      emotionalTone: plan.emotionalTone,
      wordCount,
      isOpeningArc: true,
      isHighImpact: sections.some((section) => section.isHighImpact),
      isNoShareZone: sections.some((section) => section.isNoShareZone),
      requiresDecompressionAfter: sections.some((section) => section.requiresDecompressionAfter),
      eligibleForResonanceMapping: plan.componentIndex > 0,
      contentNoticeKey: plan.contentNoticeKey ?? null,
      sourceParagraphRange: { start: slice[0].index, end: slice[slice.length - 1].index },
      blocks,
    };

    units.push(component, ...sections);
  });

  for (const unit of units) {
    unit.sequenceIndex = unit.componentIndex;
    unit.readingOrder = readingOrder;
    unit.contentVersion = RELEASE.contentVersion;
    unit.contentHash = sha256(canonicalJson(unit.blocks));
    unit.emotionalMetadata = {};
    unit.textRef = `content/generated/units/${unit.unitId}.json`;
    readingOrder += 1;
  }

  return { units, problems };
}

function toUnitDocument(unit) {
  return {
    unitId: unit.unitId,
    releaseId: RELEASE.releaseId,
    workId: RELEASE.workId,
    edition: RELEASE.edition,
    branch: RELEASE.branch,
    manuscriptVersion: RELEASE.manuscriptVersion,
    contentLayer: RELEASE.contentLayer,
    parentUnitId: unit.parentUnitId,
    unitType: unit.unitType,
    sequenceIndex: unit.sequenceIndex,
    readingOrder: unit.readingOrder,
    componentIndex: unit.componentIndex,
    chapterNumber: unit.chapterNumber,
    chapterLabel: unit.chapterLabel,
    sectionNumber: unit.sectionNumber,
    canonicalTitle: unit.canonicalTitle,
    contentRole: unit.contentRole,
    emotionalTone: unit.emotionalTone,
    wordCount: unit.wordCount,
    isOpeningArc: unit.isOpeningArc,
    isHighImpact: unit.isHighImpact,
    isNoShareZone: unit.isNoShareZone,
    requiresDecompressionAfter: unit.requiresDecompressionAfter,
    eligibleForResonanceMapping: unit.eligibleForResonanceMapping,
    contentNoticeKey: unit.contentNoticeKey,
    emotionalMetadata: unit.emotionalMetadata,
    contentVersion: unit.contentVersion,
    contentHash: unit.contentHash,
    sourceParagraphRange: unit.sourceParagraphRange,
    blocks: unit.blocks,
  };
}

function toReleaseDocument(units, source, releaseId) {
  const components = units.filter((unit) => unit.parentUnitId === null);
  const totalWordCount = components.reduce((total, unit) => total + unit.wordCount, 0);
  const checksums = units.map((unit) => ({ unitId: unit.unitId, contentHash: unit.contentHash }));

  return {
    releaseId,
    workId: RELEASE.workId,
    edition: RELEASE.edition,
    branch: RELEASE.branch,
    manuscriptVersion: RELEASE.manuscriptVersion,
    arc: RELEASE.arc,
    contentLayer: RELEASE.contentLayer,
    contentVersion: RELEASE.contentVersion,
    generatedAt: new Date().toISOString(),
    source: {
      fileName: path.basename(source.path),
      byteLength: source.bytes,
      sha256: source.sha256,
    },
    componentCount: components.length,
    unitCount: units.length,
    totalWordCount,
    contentHash: sha256(canonicalJson(checksums)),
    units: units.map((unit) => ({
      unitId: unit.unitId,
      parentUnitId: unit.parentUnitId,
      unitType: unit.unitType,
      sequenceIndex: unit.sequenceIndex,
      readingOrder: unit.readingOrder,
      componentIndex: unit.componentIndex,
      chapterNumber: unit.chapterNumber,
      chapterLabel: unit.chapterLabel,
      sectionNumber: unit.sectionNumber,
      canonicalTitle: unit.canonicalTitle,
      contentRole: unit.contentRole,
      emotionalTone: unit.emotionalTone,
      wordCount: unit.wordCount,
      isOpeningArc: unit.isOpeningArc,
      isHighImpact: unit.isHighImpact,
      isNoShareZone: unit.isNoShareZone,
      requiresDecompressionAfter: unit.requiresDecompressionAfter,
      contentNoticeKey: unit.contentNoticeKey,
      contentVersion: unit.contentVersion,
      contentHash: unit.contentHash,
      textRef: unit.textRef,
    })),
  };
}

function writeRelease(outDir, release, units) {
  const unitsDir = path.join(outDir, 'units');
  fs.mkdirSync(unitsDir, { recursive: true });

  for (const name of fs.readdirSync(unitsDir)) {
    if (/^CU-[A-Z0-9-]+\.json$/.test(name)) fs.rmSync(path.join(unitsDir, name));
  }

  fs.writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  for (const unit of units) {
    fs.writeFileSync(
      path.join(unitsDir, `${unit.unitId}.json`),
      `${JSON.stringify(toUnitDocument(unit), null, 2)}\n`,
      'utf8',
    );
  }
}

const SUMMARY_COLUMNS = [
  { key: 'component', label: 'CMP', width: 4 },
  { key: 'unitId', label: 'UNIT ID', width: 20 },
  { key: 'type', label: 'TYPE', width: 13 },
  { key: 'words', label: 'WORDS', width: 7, align: 'right' },
  { key: 'delta', label: 'Δ', width: 7, align: 'right' },
  { key: 'blocks', label: 'BLOCKS', width: 34 },
  { key: 'title', label: 'TITLE', width: 0 },
];

function cell(value, width, align) {
  if (width === 0) return value;
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function formatBlockCounts(counts) {
  return Object.keys(counts)
    .sort()
    .map((type) => `${type} ${counts[type]}`)
    .join(', ');
}

function printSummary(units) {
  console.log(SUMMARY_COLUMNS.map((column) => cell(column.label, column.width)).join('  '));
  console.log(SUMMARY_COLUMNS.map((column) => cell('', column.width).replace(/ /g, '-')).join('  '));

  for (const unit of units) {
    const isComponent = unit.parentUnitId === null;
    const plan = isComponent ? COMPONENT_PLAN[unit.componentIndex] : null;
    const delta = plan ? unit.wordCount - plan.expectedWordCount : null;
    const row = {
      component: isComponent ? String(unit.componentIndex) : '',
      unitId: isComponent ? unit.unitId : `  ${unit.unitId}`,
      type: unit.unitType,
      words: String(unit.wordCount),
      delta: delta === null ? '' : delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${delta}`,
      blocks: formatBlockCounts(countBlockTypes(unit.blocks)),
      title: unit.canonicalTitle,
    };
    console.log(SUMMARY_COLUMNS.map((column) => cell(row[column.key], column.width, column.align)).join('  '));
  }
}

function printTagging(units) {
  console.log('\nProtection tagging (master doc 3.6.3 [PROPOSED], pending human-review gate):');
  for (const unit of units) {
    const flags = [
      unit.isHighImpact ? 'highImpact' : null,
      unit.isNoShareZone ? 'noShareZone' : null,
      unit.requiresDecompressionAfter ? 'decompressionAfter' : null,
      unit.contentNoticeKey ? `notice=${unit.contentNoticeKey}` : null,
    ].filter(Boolean);
    if (flags.length > 0) console.log(`  ${unit.unitId.padEnd(20)} ${flags.join(' · ')}`);
  }
}

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    outDir: DEFAULT_OUT_DIR,
    releaseId: RELEASE.releaseId,
    dryRun: false,
  };

  for (const argument of argv) {
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument.startsWith('--source=')) {
      options.source = path.resolve(argument.slice('--source='.length));
    } else if (argument.startsWith('--out=')) {
      options.outDir = path.resolve(argument.slice('--out='.length));
    } else if (argument.startsWith('--release=')) {
      options.releaseId = argument.slice('--release='.length);
    } else {
      throw new Error(
        `Unknown argument "${argument}". Usage: ingest-manuscript.mjs ` +
          '[--source=<path.docx>] [--out=<dir>] [--release=<id>] [--dry-run]',
      );
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.source)) {
    throw new Error(`Source manuscript not found: ${options.source}`);
  }

  const sourceBytes = fs.readFileSync(options.source);
  const extraction = extractDocumentXml(options.source);
  const paragraphs = parseParagraphs(extraction.xml);
  const { units, problems } = buildUnits(paragraphs);

  const release = toReleaseDocument(
    units,
    {
      path: options.source,
      bytes: sourceBytes.length,
      sha256: sha256Bytes(sourceBytes),
    },
    options.releaseId,
  );

  console.log(`Source     ${options.source}`);
  console.log(`Extraction ${extraction.method} · ${paragraphs.length} paragraphs`);
  console.log(`Release    ${release.releaseId} · ${release.edition} · branch ${release.branch}`);
  console.log(`Work       ${release.workId}\n`);

  printSummary(units);

  const expectedTotal = COMPONENT_PLAN.reduce((total, plan) => total + plan.expectedWordCount, 0);
  const totalDelta = release.totalWordCount - expectedTotal;
  console.log(
    `\nComponents ${release.componentCount} · units ${release.unitCount} · ` +
      `words ${release.totalWordCount} (locked table ${expectedTotal}, drift ${totalDelta >= 0 ? '+' : ''}${totalDelta})`,
  );
  console.log(`Release contentHash ${release.contentHash}`);

  printTagging(units);

  const drifted = units.filter(
    (unit) =>
      unit.parentUnitId === null &&
      unit.wordCount !== COMPONENT_PLAN[unit.componentIndex].expectedWordCount,
  );
  if (drifted.length > 0) {
    console.warn(
      `\nWord-count drift on ${drifted.length} component(s) — reported, not fatal. ` +
        'Reconcile against master doc 3.5.2 before certifying this release.',
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    throw new Error('Locked Opening Arc sequence verification failed. Nothing was written.');
  }

  if (options.dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  writeRelease(options.outDir, release, units);
  console.log(`\nWrote ${options.outDir}${path.sep}release.json and ${units.length} unit files.`);
}

try {
  main();
} catch (error) {
  console.error(`ingest-manuscript: ${error.message}`);
  process.exitCode = 1;
}
