#!/usr/bin/env node
/**
 * Seed a database with everything the Reading Room needs to open.
 *
 * Idempotent by construction: every write is an upsert keyed on the document's natural
 * identifier, so running this twice changes nothing the second time. That matters more than it
 * usually does, because two of these collections are governed rather than merely stored.
 *
 * What is deliberately NOT done here:
 *
 *   - Resonance nodes are seeded with `qa_status.validated: false`. §3.6.3 makes human review a
 *     gate ("human review validates every no-share zone and decompression window"), and a seed
 *     script is not a human. Seeding them pre-validated would let the sharing gate open on
 *     windows nobody has read.
 *   - Sharing prompts are seeded `active: false` with `requires_human_review: true`. A prompt
 *     that appears to a reader without an editor having approved its wording is exactly the
 *     failure §5.3 exists to prevent.
 *   - The hardcover product is seeded with `priceCents: null` and `purchasable: false`. No price
 *     exists anywhere in the corpus (§6.10), and the purchase flow must not be activatable until
 *     the founder sets one.
 *
 * Usage:
 *   node scripts/seed.mjs [--only=<collection>] [--drop] [--dry-run]
 *
 * @module scripts/seed
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import config from '../src/config/index.js';
import { COLLECTIONS } from '../src/db/collections.js';
import { assertCleanCopy } from '../src/lib/rulesLint.js';
import { connect, fail, heading, helpIfAsked, parseArgs, refuseInProduction, style, table } from './lib/cli.mjs';
import { QUESTIONNAIRE_V2 } from './lib/questionnaire-v2.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(SCRIPT_DIR, '..', 'content', 'generated');

const USAGE = `
seed — populate a database with the certified release and its governance records

  node scripts/seed.mjs [options]

Options
  --only=<name>   Seed one collection only (manuscripts, manuscript_units,
                  resonance_nodes, sharing_prompts, questionnaires, cohorts, products).
  --drop          Empty the seeded collections first. Refused when NODE_ENV=production.
  --dry-run       Report what would be written and touch nothing.
  --help          This text.

Run scripts/ingest-manuscript.mjs first — this script reads its output rather than
re-parsing the manuscript, so the text a database serves is byte-identical to the
certified release on disk.
`;

const { flags } = parseArgs();
helpIfAsked(flags, USAGE);

const dryRun = Boolean(flags['dry-run']);
const only = typeof flags.only === 'string' ? flags.only : null;
const drop = Boolean(flags.drop);

if (drop) refuseInProduction(config, 'drop seeded collections');

/* -------------------------------------------------------------------------- */
/* The certified release                                                       */
/* -------------------------------------------------------------------------- */

const releasePath = path.join(CONTENT_DIR, 'release.json');
if (!fs.existsSync(releasePath)) {
  fail(
    `No certified release at ${releasePath}.\n  Run: node scripts/ingest-manuscript.mjs`,
    5,
  );
}

/** @type {{ releaseId: string, workId: string, edition: string, branch: string, manuscriptVersion: string, contentHash: string, totalWordCount: number, units: object[] }} */
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));

/**
 * Load one unit's full document, including its blocks.
 *
 * @param {object} entry A release manifest entry.
 * @returns {object} The unit document.
 */
function loadUnit(entry) {
  const file = path.join(CONTENT_DIR, 'units', `${entry.unitId}.json`);
  if (!fs.existsSync(file)) fail(`Release manifest names ${entry.unitId} but ${file} is missing.`, 5);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* -------------------------------------------------------------------------- */
/* Governance records                                                          */
/* -------------------------------------------------------------------------- */

const MANUSCRIPT = {
  _id: 'manuscript_now_or_never_one',
  title: 'Now or Never – One',
  subtitle: 'The Global Family Unites to Save the World',
  workId: release.workId,
  edition: release.edition,
  // The public API hard-filters on this. Only a public branch is ever servable, and the
  // Confidential Development Edition must never acquire one (§9.2.1).
  branch: 'public',
  version: release.manuscriptVersion,
  isCanonical: true,
  // Always true, in every release, forever: "The Opening Arc always remains untouched."
  openingArcLocked: true,
  chapterCount: 25,
  status: 'published',
  releaseId: release.releaseId,
  contentHash: release.contentHash,
  schemaVersion: 1,
};

/**
 * The initial resonance map (§3.6.3, [PROPOSED] tagging, pending the human-review gate).
 *
 * Each node points at a unit and says what kind of moment it is. Nothing here is validated —
 * `qa_status.validated` is false on every one, which means the sharing gate treats none of
 * them as an open window yet. That is the correct starting state: the map is an editorial
 * artefact, and it becomes operative when a person says it does.
 *
 * @returns {object[]} Node documents.
 */
function resonanceNodes() {
  const nodes = [];
  let ordinal = 0;

  const add = (unitId, nodeType, summary) => {
    ordinal += 1;
    nodes.push({
      _id: `RN-OA-${String(ordinal).padStart(4, '0')}`,
      node_id: `RN-OA-${String(ordinal).padStart(4, '0')}`,
      manuscript_unit_id: unitId,
      node_type: nodeType,
      summary,
      // §3.6.3 [OPEN QUESTION]: every score field in the handoff is a bare integer with no
      // scale and no threshold, and the "K1.3+ threshold model" is named but never defined.
      // Until the founder supplies definitions, the gates operate on flags and node presence
      // alone — so the scores are left empty rather than invented.
      scores: {},
      qa_status: { validated: false, validatedBy: null, validatedAt: null },
      schemaVersion: 1,
    });
  };

  const units = new Map(release.units.map((unit) => [unit.unitId, unit]));
  const has = (unitId) => units.has(unitId);

  // Recognition peaks.
  if (has('CU-NONO-OA-003-S07')) add('CU-NONO-OA-003-S07', 'recognition_peak', 'Chapter 0 §7 — The Global Family Outside the Room');
  if (has('CU-NONO-OA-008-S01')) add('CU-NONO-OA-008-S01', 'recognition_peak', 'Chapter 1 §1 — You Were Right About the World');
  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'recognition_peak', 'Chapter 1 §8 — The Threshold');

  // No-share zones: the witness sections, and the machinery chapter's core.
  for (const unitId of [
    'CU-NONO-OA-004-S02',
    'CU-NONO-OA-004-S03',
    'CU-NONO-OA-004-S04',
    'CU-NONO-OA-004-S05',
    'CU-NONO-OA-004-S06',
    'CU-NONO-OA-004-S07',
    'CU-NONO-OA-008-S04',
    'CU-NONO-OA-008-S05',
    'CU-NONO-OA-008-S07',
  ]) {
    if (has(unitId)) add(unitId, 'no_share_zone', 'Witness material — sharing suppressed');
  }

  // Decompression windows follow the heaviest passages.
  if (has('CU-NONO-OA-004-S09')) add('CU-NONO-OA-004-S09', 'decompression_window', 'After Chapter 00’s invitation');
  if (has('CU-NONO-OA-007')) add('CU-NONO-OA-007', 'decompression_window', 'After The Forgetting');
  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'decompression_window', 'After Chapter 1 §8');
  if (has('CU-NONO-OA-010')) add('CU-NONO-OA-010', 'decompression_window', 'After the Introduction');

  // Return windows at every component boundary.
  for (const unit of release.units.filter((entry) => !entry.parentUnitId && entry.componentIndex > 0)) {
    add(unit.unitId, 'return_window', `Boundary before ${unit.canonicalTitle}`);
  }

  // Convergence thresholds — the only places "Become Family." may ever render.
  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'convergence_threshold', 'Chapter 1 §8 — The Threshold');
  if (has('CU-NONO-OA-011')) add('CU-NONO-OA-011', 'convergence_threshold', 'Transition to Chapter 2 — Awareness');

  return nodes;
}

/**
 * Sharing prompts. Every string here passes the prohibited-terms lint before it is written,
 * and every one is seeded inactive.
 *
 * @returns {object[]} Prompt documents.
 */
function sharingPrompts() {
  const prompts = [
    {
      prompt_id: 'sp_quiet_offer',
      prompt_type: 'silent',
      prompt_text: 'If someone came to mind while you were reading, you can offer them their own beginning.',
      allowed_window_types: ['decompression', 'human_reconnection'],
      visual_treatment: 'quiet_inline',
    },
    {
      prompt_id: 'sp_continuity',
      prompt_type: 'continuity',
      prompt_text: 'This reading can be passed on, whole, to one person.',
      allowed_window_types: ['return', 'human_reconnection'],
      visual_treatment: 'minimal',
    },
    {
      prompt_id: 'sp_reflective',
      prompt_type: 'reflective',
      prompt_text: 'Who else would recognise what you have just read?',
      allowed_window_types: ['decompression', 'quiet_recognition'],
      visual_treatment: 'isolated',
    },
    {
      prompt_id: 'sp_threshold',
      prompt_type: 'threshold',
      prompt_text: 'What you carry from here is yours to keep, or to hand on.',
      allowed_window_types: ['convergence'],
      visual_treatment: 'full_breath',
    },
  ];

  return prompts.map((prompt) => {
    // A prompt is the one piece of copy an editor writes directly into the database. Lint it
    // here so a banned word can never be seeded, only rejected.
    assertCleanCopy(prompt.prompt_text, `sharing_prompts.${prompt.prompt_id}.prompt_text`);

    return {
      _id: prompt.prompt_id,
      ...prompt,
      // The enum has exactly one value. Sharing is rare by definition, not by tuning.
      frequency: 'rare',
      cooldown_units: 8,
      requires_human_review: true,
      active: false,
      schemaVersion: 1,
    };
  });
}

/**
 * The Questionnaire v2.0 instrument, loaded from `scripts/lib/questionnaire-v2.mjs`.
 *
 * Questions are data, never code (§9.2.8), so the instrument lives in a file of its own
 * rather than inline here: editing a question is then a change to one reviewable document
 * instead of a change to the seeder.
 */
const QUESTIONNAIRE = QUESTIONNAIRE_V2;

const COHORT = {
  _id: 'cohort_one',
  name: 'Cohort One',
  type: 'individual',
  organizationName: null,
  targetSize: 50,
  minimumSize: 15,
  questionnaireId: 'q_v2_0',
  manuscriptEdition: release.edition,
  status: 'planned',
  notes: 'Age-varied Founding Readers. The interim intake is LinkedIn to email to Airtable, imported with scripts/airtable-import.mjs.',
  schemaVersion: 1,
};

const PRODUCT = {
  _id: 'prod_hardcover_v1',
  sku: 'hardcover-standard',
  type: 'hardcover',
  name: '"Now or Never – One" — Hardcover Edition',
  edition: 'hardcover_standard',
  // No price exists anywhere in the corpus. The field ships null and the purchase flow cannot
  // activate until the founder sets one (§6.7, §6.10).
  priceCents: null,
  currency: 'USD',
  reservable: true,
  purchasable: false,
  shippingRequired: true,
  active: true,
  status: 'reservable',
  schemaVersion: 1,
};

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const PLAN = [
  { name: COLLECTIONS.MANUSCRIPTS, documents: () => [MANUSCRIPT] },
  {
    name: COLLECTIONS.MANUSCRIPT_UNITS,
    documents: () =>
      release.units.map((entry) => ({
        ...loadUnit(entry),
        _id: entry.unitId,
        manuscriptId: MANUSCRIPT._id,
        releaseId: release.releaseId,
        status: 'published',
        schemaVersion: 1,
      })),
  },
  { name: COLLECTIONS.RESONANCE_NODES, documents: resonanceNodes },
  { name: COLLECTIONS.SHARING_PROMPTS, documents: sharingPrompts },
  { name: COLLECTIONS.QUESTIONNAIRES, documents: () => [QUESTIONNAIRE] },
  { name: COLLECTIONS.COHORTS, documents: () => [COHORT] },
  { name: COLLECTIONS.PRODUCTS, documents: () => [PRODUCT] },
];

const selected = only ? PLAN.filter((step) => step.name === only) : PLAN;
if (only && selected.length === 0) {
  fail(`Unknown collection "${only}". One of: ${PLAN.map((step) => step.name).join(', ')}`);
}

heading(`Certified release ${release.releaseId}`);
console.log(`  edition        ${release.edition} (${release.branch})`);
console.log(`  units          ${release.units.length}`);
console.log(`  words          ${release.totalWordCount ?? '—'}`);
console.log(`  contentHash    ${style.dim(release.contentHash ?? '—')}`);

if (dryRun) {
  heading('Plan (--dry-run: nothing written)');
  table(
    ['collection', 'documents'],
    selected.map((step) => [step.name, String(step.documents().length)]),
  );
  console.log(
    style.dim(
      '\nResonance nodes seed unvalidated and sharing prompts seed inactive, on purpose:\n' +
        'human review is a gate, and a script is not a human.\n',
    ),
  );
  process.exit(0);
}

const { db, close } = await connect(config);
const results = [];

try {
  for (const step of selected) {
    const documents = step.documents();
    const collection = db.collection(step.name);

    if (drop) await collection.deleteMany({});

    let inserted = 0;
    let updated = 0;
    const now = new Date();

    for (const document of documents) {
      const { _id, ...rest } = document;
      const result = await collection.updateOne(
        { _id },
        { $set: { ...rest, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      if (result.upsertedId) inserted += 1;
      else updated += 1;
    }

    results.push([step.name, String(documents.length), String(inserted), String(updated)]);
  }

  heading('Seeded');
  table(['collection', 'documents', 'inserted', 'unchanged or updated'], results);

  console.log(
    style.yellow(
      '\nBefore any of this is operative:\n' +
        '  · a person must validate each resonance node (no-share zones and decompression windows)\n' +
        '  · an editor must review and activate each sharing prompt\n' +
        '  · the founder must set products.priceCents before the hardcover purchase flow can open\n',
    ),
  );
} finally {
  await close();
}
