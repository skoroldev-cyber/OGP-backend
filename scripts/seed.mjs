#!/usr/bin/env node
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

const releasePath = path.join(CONTENT_DIR, 'release.json');
if (!fs.existsSync(releasePath)) {
  fail(
    `No certified release at ${releasePath}.\n  Run: node scripts/ingest-manuscript.mjs`,
    5,
  );
}

const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));

function loadUnit(entry) {
  const file = path.join(CONTENT_DIR, 'units', `${entry.unitId}.json`);
  if (!fs.existsSync(file)) fail(`Release manifest names ${entry.unitId} but ${file} is missing.`, 5);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const MANUSCRIPT = {
  _id: 'manuscript_now_or_never_one',
  title: 'Now or Never – One',
  subtitle: 'The Global Family Unites to Save the World',
  workId: release.workId,
  edition: release.edition,
  branch: 'public',
  version: release.manuscriptVersion,
  isCanonical: true,
  openingArcLocked: true,
  chapterCount: 25,
  status: 'published',
  releaseId: release.releaseId,
  contentHash: release.contentHash,
  schemaVersion: 1,
};

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
      scores: {},
      qa_status: { validated: false, validatedBy: null, validatedAt: null },
      schemaVersion: 1,
    });
  };

  const units = new Map(release.units.map((unit) => [unit.unitId, unit]));
  const has = (unitId) => units.has(unitId);

  if (has('CU-NONO-OA-003-S07')) add('CU-NONO-OA-003-S07', 'recognition_peak', 'Chapter 0 §7 — The Global Family Outside the Room');
  if (has('CU-NONO-OA-008-S01')) add('CU-NONO-OA-008-S01', 'recognition_peak', 'Chapter 1 §1 — You Were Right About the World');
  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'recognition_peak', 'Chapter 1 §8 — The Threshold');

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

  if (has('CU-NONO-OA-004-S09')) add('CU-NONO-OA-004-S09', 'decompression_window', 'After Chapter 00’s invitation');
  if (has('CU-NONO-OA-007')) add('CU-NONO-OA-007', 'decompression_window', 'After The Forgetting');
  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'decompression_window', 'After Chapter 1 §8');
  if (has('CU-NONO-OA-010')) add('CU-NONO-OA-010', 'decompression_window', 'After the Introduction');

  for (const unit of release.units.filter((entry) => !entry.parentUnitId && entry.componentIndex > 0)) {
    add(unit.unitId, 'return_window', `Boundary before ${unit.canonicalTitle}`);
  }

  if (has('CU-NONO-OA-008-S08')) add('CU-NONO-OA-008-S08', 'convergence_threshold', 'Chapter 1 §8 — The Threshold');
  if (has('CU-NONO-OA-011')) add('CU-NONO-OA-011', 'convergence_threshold', 'Transition to Chapter 2 — Awareness');

  return nodes;
}

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
    assertCleanCopy(prompt.prompt_text, `sharing_prompts.${prompt.prompt_id}.prompt_text`);

    return {
      _id: prompt.prompt_id,
      ...prompt,
      frequency: 'rare',
      cooldown_units: 8,
      requires_human_review: true,
      active: false,
      schemaVersion: 1,
    };
  });
}

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
  priceCents: null,
  currency: 'USD',
  reservable: true,
  purchasable: false,
  shippingRequired: true,
  active: true,
  status: 'reservable',
  schemaVersion: 1,
};

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
