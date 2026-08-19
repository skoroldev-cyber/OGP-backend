#!/usr/bin/env node
/**
 * Import Founding Reader interest from the interim intake.
 *
 * §5 calls the current process the "Simple Solution for Now": LinkedIn to
 * foundingbetareaders@oneglobalpeople.org to Airtable to a private reading link. Airtable
 * exports CSV, so this reads CSV, and it is a one-time bridge rather than an integration —
 * when the beta dashboard exists, this script retires.
 *
 * The privacy wall is structural and this script is where it is first built (§9.2.7):
 * `invitations` holds the contact details, `reading_sessions` holds none, and the only join
 * between them is `redeemedBySessionId`, which exists for completion tracking and nothing else.
 * No column in a spreadsheet may become a profiling field, so every incoming key is checked
 * against PROHIBITED_FIELDS before anything is written.
 *
 * Usage:
 *   node scripts/airtable-import.mjs --file=interest.csv --cohort=cohort_one [--dry-run]
 *
 * @module scripts/airtable-import
 */

import fs from 'node:fs';
import process from 'node:process';

import config from '../src/config/index.js';
import { COLLECTIONS } from '../src/db/collections.js';
import { PROHIBITED_FIELDS } from '../src/config/constants.js';
import { newId, opaqueToken } from '../src/lib/ids.js';
import { connect, fail, heading, helpIfAsked, parseArgs, style, table } from './lib/cli.mjs';

const USAGE = `
airtable-import — import Founding Reader interest from a CSV export

  node scripts/airtable-import.mjs --file=<path.csv> --cohort=<cohortId> [options]

Options
  --file=<path>      Required. An Airtable CSV export.
  --cohort=<id>      Required. Must already exist (see scripts/seed.mjs).
  --status=<status>  Initial status. Default: new_interest.
  --dry-run          Report what would be written and touch nothing.
  --help             This text.

Recognised columns (case- and space-insensitive):
  email · name / display name / full name · country · language / preferred language
  occupation / background / occupation background · source · notes

Any other column is ignored. A column whose name matches a prohibited profiling field
(birthdate, gender, and the rest) aborts the import rather than being dropped quietly.
`;

const { flags } = parseArgs();
helpIfAsked(flags, USAGE);

const file = typeof flags.file === 'string' ? flags.file : null;
const cohortId = typeof flags.cohort === 'string' ? flags.cohort : null;
const initialStatus = typeof flags.status === 'string' ? flags.status : 'new_interest';
const dryRun = Boolean(flags['dry-run']);

if (!file) fail('--file=<path.csv> is required.');
if (!cohortId) fail('--cohort=<cohortId> is required.');
if (!fs.existsSync(file)) fail(`No such file: ${file}`);

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Parse RFC 4180 CSV.
 *
 * Written out rather than pulled in: an Airtable export routinely contains commas inside
 * quoted notes, newlines inside quoted notes, and doubled quotes, and a naive `split(',')`
 * silently corrupts exactly the rows a human took the trouble to write.
 *
 * @param {string} text The file contents.
 * @returns {string[][]} Rows of cells.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let index = 0;

  // A UTF-8 BOM would otherwise become part of the first header name.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < source.length) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(cell);
      cell = '';
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

/** Normalise a header for matching: lowercase, alphanumerics only. */
const normaliseHeader = (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Recognised columns, by normalised header. */
const COLUMN_MAP = {
  email: 'email',
  emailaddress: 'email',
  name: 'displayName',
  displayname: 'displayName',
  fullname: 'displayName',
  country: 'country',
  language: 'preferredLanguage',
  preferredlanguage: 'preferredLanguage',
  occupation: 'occupationBackground',
  background: 'occupationBackground',
  occupationbackground: 'occupationBackground',
  source: 'source',
  notes: 'notes',
};

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
if (rows.length < 2) fail('The CSV has no data rows.');

const headers = rows[0].map(normaliseHeader);

// A spreadsheet column named `gender` or `birthdate` is not dropped quietly — it aborts. If
// someone has been collecting it, that is worth knowing before it reaches a database.
const prohibited = headers.filter((header) =>
  PROHIBITED_FIELDS.some((field) => normaliseHeader(field) === header),
);
if (prohibited.length > 0) {
  fail(
    `The CSV carries prohibited profiling columns: ${prohibited.join(', ')}.\n` +
      '  §14.4.3 forbids these fields anywhere in the data model. Remove the columns from the\n' +
      '  export — and from wherever they are being collected — before importing.',
    7,
  );
}

const emailColumn = headers.indexOf('email') === -1 ? headers.indexOf('emailaddress') : headers.indexOf('email');
if (emailColumn === -1) fail('The CSV has no email column.');

const records = rows.slice(1).map((cells) => {
  const record = {};
  headers.forEach((header, column) => {
    const field = COLUMN_MAP[header];
    if (!field) return;
    const value = (cells[column] ?? '').trim();
    if (value) record[field] = value;
  });
  return record;
});

const usable = records.filter((record) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email ?? ''));
const skipped = records.length - usable.length;

heading(`Parsed ${file}`);
console.log(`  rows            ${records.length}`);
console.log(`  usable          ${usable.length}`);
if (skipped > 0) console.log(style.yellow(`  skipped         ${skipped} (no valid email)`));
console.log(`  columns kept    ${[...new Set(headers.map((h) => COLUMN_MAP[h]).filter(Boolean))].join(', ')}`);

if (dryRun) {
  heading('Plan (--dry-run: nothing written)');
  table(
    ['email', 'name', 'country', 'source'],
    usable.slice(0, 12).map((record) => [
      record.email,
      record.displayName ?? '',
      record.country ?? '',
      record.source ?? 'linkedin',
    ]),
  );
  if (usable.length > 12) console.log(style.dim(`  … and ${usable.length - 12} more`));
  console.log('');
  process.exit(0);
}

const { db, close } = await connect(config);

try {
  const cohort = await db.collection(COLLECTIONS.COHORTS).findOne({ _id: cohortId });
  if (!cohort) fail(`No cohort "${cohortId}". Run scripts/seed.mjs, or create it first.`, 5);

  const invitations = db.collection(COLLECTIONS.INVITATIONS);
  let inserted = 0;
  let existing = 0;

  for (const record of usable) {
    const email = record.email.toLowerCase();
    if (await invitations.findOne({ email })) {
      existing += 1;
      continue;
    }

    const now = new Date();
    await invitations.insertOne({
      _id: newId(),
      cohortId,
      // The private reading link is possession-based and single-use. It is never emailed as an
      // attachment — §14.4.5 forbids sending the manuscript as a file.
      code: opaqueToken(),
      email,
      displayName: record.displayName ?? null,
      country: record.country ?? null,
      preferredLanguage: record.preferredLanguage ?? null,
      occupationBackground: record.occupationBackground ?? null,
      source: record.source ?? 'linkedin',
      status: initialStatus,
      redeemedBySessionId: null,
      redeemedAt: null,
      welcomeEmailSentAt: null,
      notes: record.notes ?? null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    inserted += 1;
  }

  heading('Imported');
  console.log(`  cohort          ${cohort.name}`);
  console.log(`  inserted        ${style.green(String(inserted))}`);
  console.log(`  already present ${existing}`);
  console.log(
    style.dim(
      '\nInvitation codes are opaque and single-use. Send the private reading link — never the\n' +
        'manuscript as an attachment.\n',
    ),
  );
} finally {
  await close();
}
