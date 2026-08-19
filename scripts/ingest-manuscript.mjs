#!/usr/bin/env node
/**
 * Opening Arc manuscript ingestion.
 *
 * Reads the governing display text — the Beta Reader Edition v2.0 .docx — and emits an
 * immutable, checksummed certified release: `content/generated/release.json` plus one
 * JSON file per ManuscriptUnit under `content/generated/units/`.
 *
 * Laws this script exists to enforce:
 *   - The Opening Arc text is immutable. It is extracted, never edited, never re-authored.
 *   - The twelve protected components render in the LOCKED order (master doc 3.5.2).
 *   - `blocks[]` is the only render contract (BUILD_CONTRACT 6). Nothing else is emitted.
 *   - Bold and italic emphasis exists only in the DOCX and MUST survive ingestion (master 3.4.1).
 *   - Authored line breaks are semantic. Stanzas are never re-wrapped.
 *
 * Usage:
 *   node scripts/ingest-manuscript.mjs [--source=<path.docx>] [--out=<dir>]
 *                                      [--release=<REL-...>] [--dry-run]
 *
 * @module scripts/ingest-manuscript
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractDocumentXml, parseParagraphs } from './lib/docx.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

// ---------------------------------------------------------------------------
// Release identity (master doc 3.5.1, 3.6.2 — one Work, many immutable Releases)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Segmentation and classification configuration (no magic literals below this block)
// ---------------------------------------------------------------------------

/** Heading level that opens a protected component. */
const COMPONENT_HEADING_LEVEL = 1;
/** Heading level that opens a section-level child unit inside a chapter. */
const SECTION_HEADING_LEVEL = 2;
/** Heading level that may open an inset micro-story. */
const MICROSTORY_HEADING_LEVEL = 3;
/** A paragraph of at most this many words is breath-paced and joins a stanza. */
const STANZA_MAX_WORDS = 12;
/** A stanza needs at least this many consecutive breath lines; a lone line stays a paragraph. */
const STANZA_MIN_LINES = 2;
/** How far the epigraph matcher looks ahead for the `— One` signature. */
const EPIGRAPH_MAX_PARAGRAPHS = 6;

const MICROSTORY_TITLE_PATTERN = /^micro-?story\b/i;
const DIVIDER_PATTERN = /^(?:-{3,}|\*{3,})$/;
const OPEN_QUOTE_PATTERN = /^["“‘«]/;
const CLOSE_QUOTE_PATTERN = /["”’»]\s*$/;
const ATTRIBUTION_PATTERN = /[—–]\s*One\s*$/;
const ATTRIBUTION_SUFFIX_PATTERN = /\s*[—–]\s*One\s*$/;
const TERMINAL_COLON_PATTERN = /:\s*$/;
const EPIGRAPH_ATTRIBUTION = '— One';

/** Authored reader cues (master doc 3.4.2) — rendered as manuscript voice, not as UI chrome. */
const CUE_PREFIXES = ['Turn the page.', 'Take a breath. Then turn the page.'];

/** Section number readers: `Section 4 — …` (Chapters 0 and 1) and `4. …` (Chapter 00). */
const SECTION_NUMBER_PATTERNS = [/^Section\s+(\d+)\b/i, /^(\d+)\s*[.)]/];

/**
 * The LOCKED twelve protected components (master doc 3.5.2). Order must not change.
 * `expectedTitle` verifies the derived Heading1 spine; `canonicalTitle` is always taken
 * verbatim from the document itself (component 0 carries no heading of its own).
 */
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

/**
 * [PROPOSED] initial editorial tagging for the v2.0 arc (master doc 3.6.3), subject to the
 * human-review gate. Everything here is build-time and human-governed; nothing is inferred
 * from a reader at runtime. Keys are unit ids so the tagging is auditable line by line.
 */
const SECTION_METADATA = {
  // Chapter 0 — recognition peak at §7, orientation hand-off at §8 ("Turn the page.").
  'CU-NONO-OA-003-S07': { contentRole: 'recognition', emotionalTone: 'reflective' },
  'CU-NONO-OA-003-S08': { contentRole: 'orientation', emotionalTone: 'clarifying' },

  // Chapter 00 parts 2–7 — the operating-system exposure block.
  'CU-NONO-OA-004-S02': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S03': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S04': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S05': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S06': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S07': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-004-S09': { contentRole: 'invitation', emotionalTone: 'convergent' },

  // Chapter 1 — witness sections 4/5/7 carry accounts of harm to children.
  'CU-NONO-OA-008-S01': { contentRole: 'recognition', emotionalTone: 'reflective' },
  'CU-NONO-OA-008-S04': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S05': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S06': { emotionalTone: 'reflective' },
  'CU-NONO-OA-008-S07': { isNoShareZone: true, requiresDecompressionAfter: true, isHighImpact: true, emotionalTone: 'grave' },
  'CU-NONO-OA-008-S08': { isHighImpact: true, contentRole: 'convergence', emotionalTone: 'convergent' },
};

const DEFAULT_SECTION_CONTENT_ROLE = 'exposure';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Count whitespace-delimited words. Applied to the SOURCE paragraph stream so totals
 * reconcile exactly with the Founder Review Control Sheet table (master doc 3.5.2).
 *
 * @param {string} text any text
 * @returns {number} word count
 */
function countWords(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Normalize a heading for order verification only. Dash variants and case are collapsed so
 * the check survives encoding differences; the canonical title is never normalized.
 *
 * @param {string} text heading text
 * @returns {string} comparison key
 */
function titleKey(text) {
  return text
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Deterministic JSON with recursively sorted object keys — the hashing canon.
 *
 * @param {unknown} value any JSON-serializable value
 * @returns {string} canonical JSON text
 */
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

/**
 * @param {string} text content to digest
 * @returns {string} `sha256:<hex>`
 */
function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * @param {Buffer} buffer raw bytes to digest
 * @returns {string} `sha256:<hex>`
 */
function sha256Bytes(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

/**
 * @param {import('./lib/docx.mjs').DocxLine[]} lines source lines
 * @returns {import('./lib/docx.mjs').DocxLine[]} deep copy safe to mutate
 */
function cloneLines(lines) {
  return lines.map((line) => ({ runs: line.runs.map((run) => ({ ...run })) }));
}

/**
 * Flatten a paragraph's lines into a single run list (used by cue blocks).
 *
 * @param {import('./lib/docx.mjs').DocxParagraph} paragraph source paragraph
 * @returns {import('./lib/docx.mjs').DocxRun[]} runs
 */
function flattenRuns(paragraph) {
  return cloneLines(paragraph.lines).flatMap((line) => line.runs);
}

// ---------------------------------------------------------------------------
// Block classification (BUILD_CONTRACT 6)
// ---------------------------------------------------------------------------

/**
 * @param {import('./lib/docx.mjs').DocxParagraph} paragraph candidate
 * @returns {boolean} true when the paragraph is one of the authored reader cues
 */
function isCue(paragraph) {
  return CUE_PREFIXES.some((prefix) => paragraph.text.trim().startsWith(prefix));
}

/**
 * A breath line is a short, single-thought line whose break is semantic
 * ("Quietly." / "Consistently." / "Relentlessly.").
 *
 * @param {import('./lib/docx.mjs').DocxParagraph} paragraph candidate
 * @returns {boolean} true when the paragraph may join a stanza
 */
function isBreathParagraph(paragraph) {
  const lines = paragraph.text.split('\n');
  if (lines.some((line) => countWords(line) > STANZA_MAX_WORDS)) return false;
  return !TERMINAL_COLON_PATTERN.test(paragraph.text);
}

/**
 * Remove the trailing `— One` signature from the final line of an epigraph, keeping the
 * closing quotation mark. The signature is preserved as the block's `attribution`.
 *
 * @param {import('./lib/docx.mjs').DocxLine[]} lines epigraph lines (mutated)
 * @returns {void}
 */
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

/**
 * Try to read a One-voice epigraph starting at `start`: a quoted passage that closes with
 * the `— One` signature, either on the same paragraph or on a following one.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} paragraphs paragraph slice
 * @param {number} start index to test
 * @returns {{ block: object, nextIndex: number }|null} epigraph block, or null
 */
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
    // The quotation closed without the signature — this is body text, not an epigraph.
    if (CLOSE_QUOTE_PATTERN.test(text)) return null;
  }
  return null;
}

/**
 * Find the end of a micro-story: the next heading at or above the opening heading's level.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} paragraphs paragraph slice
 * @param {number} start first index after the micro-story heading
 * @param {number} level the opening heading's level
 * @returns {number} exclusive end index
 */
function findHeadingBoundary(paragraphs, start, level) {
  for (let index = start; index < paragraphs.length; index += 1) {
    if (paragraphs[index].level > 0 && paragraphs[index].level <= level) return index;
  }
  return paragraphs.length;
}

/**
 * Convert an ordered paragraph slice into `blocks[]` — the only renderable shapes.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} paragraphs paragraph slice
 * @returns {object[]} blocks
 */
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
    // A multi-line paragraph keeps its authored breaks; `paragraph` has no `lines` field,
    // so it degrades to a stanza rather than losing a semantic break.
    blocks.push(
      lines.length > 1 ? { type: 'stanza', lines } : { type: 'paragraph', runs: lines[0].runs },
    );
    index += 1;
  }

  flushBreathBuffer();
  return blocks;
}

/**
 * Count blocks by type, descending into micro-stories.
 *
 * @param {object[]} blocks block list
 * @param {Record<string, number>} [into] accumulator
 * @returns {Record<string, number>} counts by block type
 */
function countBlockTypes(blocks, into = {}) {
  for (const block of blocks) {
    into[block.type] = (into[block.type] ?? 0) + 1;
    if (block.type === 'microstory') countBlockTypes(block.blocks, into);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Segmentation into the twelve protected components and their section children
// ---------------------------------------------------------------------------

/**
 * @param {number} componentIndex 0..11
 * @returns {string} `CU-NONO-OA-000` style id
 */
function componentUnitId(componentIndex) {
  return `${UNIT_ID_PREFIX}-${String(componentIndex).padStart(3, '0')}`;
}

/**
 * @param {number} componentIndex 0..11
 * @param {number} sectionOrdinal 1-based position inside the component
 * @returns {string} `CU-NONO-OA-003-S01` style id
 */
function sectionUnitId(componentIndex, sectionOrdinal) {
  return `${componentUnitId(componentIndex)}-S${String(sectionOrdinal).padStart(2, '0')}`;
}

/**
 * Read the authored section number out of a Heading2 string.
 *
 * @param {string} text heading text
 * @param {number} ordinal 1-based fallback
 * @returns {number} section number
 */
function readSectionNumber(text, ordinal) {
  for (const pattern of SECTION_NUMBER_PATTERNS) {
    const match = text.trim().match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return ordinal;
}

/**
 * Split the paragraph stream on Heading1 boundaries — the twelve protected components.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} paragraphs whole document
 * @returns {{ start: number, end: number, heading: import('./lib/docx.mjs').DocxParagraph|null }[]} spans
 */
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

/**
 * Split a component span on Heading2 boundaries — the section-level render units.
 *
 * The material *before* the first Heading2 is a section too. Chapter 0 opens with its heading
 * and a One-signature epigraph; Chapter 00 opens with a 136-word framing passage. If those
 * blocks belonged to the chapter alone, a reader walking the section-level spine (§3.4.2, "one
 * section-level unit renders at a time") would never see them — and silently dropping 190 words
 * of canonical text is a plainer violation of "the Opening Arc always remains untouched" than
 * rendering something twice would be. So an opening span is emitted whenever content precedes
 * the first section, and every authored block belongs to exactly one leaf.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} slice component paragraphs
 * @returns {{ start: number, end: number, heading: object|null, isOpening: boolean }[]} spans
 */
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

  // Anything above the first section heading — the chapter heading, its epigraph, any framing
  // passage — becomes the chapter's opening unit.
  if (starts[0] > 0) {
    spans.unshift({ start: 0, end: starts[0], heading: null, isOpening: true });
  }

  return spans;
}

/**
 * Build every ManuscriptUnit for the release.
 *
 * @param {import('./lib/docx.mjs').DocxParagraph[]} paragraphs whole document
 * @returns {{ units: object[], problems: string[] }} units in reading order plus verification notes
 */
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
      // The opening unit is ordinal 0 — `-S00` — so the numbered sections keep the ordinals a
      // reader and an editor would both expect.
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
        // The opening unit carries the chapter's own heading — it is where that heading is
        // actually rendered, so the reader meets the chapter title exactly once.
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
      // A component inherits protection from any child it contains: conservative by doctrine,
      // because over-suppressing a share window is safe and under-suppressing is a violation.
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

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Compose the full on-disk shape of one unit file.
 *
 * @param {object} unit assembled unit
 * @returns {object} unit document
 */
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

/**
 * Compose the release manifest.
 *
 * @param {object[]} units units in reading order
 * @param {{ path: string, bytes: number, sha256: string }} source provenance of the .docx
 * @param {string} releaseId release identifier
 * @returns {object} release manifest document
 */
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

/**
 * Write the release to disk, replacing any previously generated unit files.
 *
 * @param {string} outDir output directory
 * @param {object} release release manifest document
 * @param {object[]} units units in reading order
 * @returns {void}
 */
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

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const SUMMARY_COLUMNS = [
  { key: 'component', label: 'CMP', width: 4 },
  { key: 'unitId', label: 'UNIT ID', width: 20 },
  { key: 'type', label: 'TYPE', width: 13 },
  { key: 'words', label: 'WORDS', width: 7, align: 'right' },
  { key: 'delta', label: 'Δ', width: 7, align: 'right' },
  { key: 'blocks', label: 'BLOCKS', width: 34 },
  { key: 'title', label: 'TITLE', width: 0 },
];

/**
 * @param {string} value cell text
 * @param {number} width column width (0 = free)
 * @param {string} [align] `right` to right-align
 * @returns {string} padded cell
 */
function cell(value, width, align) {
  if (width === 0) return value;
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

/**
 * @param {Record<string, number>} counts block counts by type
 * @returns {string} compact summary, e.g. `heading 9, paragraph 41, stanza 12`
 */
function formatBlockCounts(counts) {
  return Object.keys(counts)
    .sort()
    .map((type) => `${type} ${counts[type]}`)
    .join(', ');
}

/**
 * Print the human verification table: locked sequence, word counts, block shapes.
 *
 * @param {object[]} units units in reading order
 * @returns {void}
 */
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

/**
 * Print protection tagging so the human-review gate has something to sign off on.
 *
 * @param {object[]} units units in reading order
 * @returns {void}
 */
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv raw process arguments
 * @returns {{ source: string, outDir: string, releaseId: string, dryRun: boolean }} options
 */
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

/**
 * Entry point.
 *
 * @returns {void}
 */
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
