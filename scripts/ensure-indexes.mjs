#!/usr/bin/env node
import process from 'node:process';

import config from '../src/config/index.js';
import { COLLECTION_NAMES } from '../src/db/collections.js';
import { INDEX_SPECS, ensureIndexes } from '../src/db/indexes.js';
import { COLLECTION_VALIDATORS, applyValidators, assertNoProhibitedFields } from '../src/db/validators.js';
import { connect, heading, helpIfAsked, parseArgs, style, table } from './lib/cli.mjs';

const USAGE = `
ensure-indexes — apply collection validators and indexes

  node scripts/ensure-indexes.mjs [options]

Options
  --dry-run   Print the plan and touch nothing.
  --help      This text.

Exit codes
  0  applied (or planned, under --dry-run)
  2  database unreachable
  4  a unique index could not be applied
`;

const { flags } = parseArgs();
helpIfAsked(flags, USAGE);
const dryRun = Boolean(flags['dry-run']);

try {
  assertNoProhibitedFields(COLLECTION_VALIDATORS);
} catch (error) {
  console.error(style.red(`\n${error.message}\n`));
  process.exit(4);
}

const uniqueSpecs = Object.entries(INDEX_SPECS).flatMap(([collection, specs]) =>
  specs.filter((spec) => spec.options?.unique).map((spec) => [collection, spec.name]),
);

heading('Plan');
table(
  ['collection', 'validator', 'indexes', 'unique'],
  COLLECTION_NAMES.map((name) => [
    name,
    COLLECTION_VALIDATORS[name] ? 'yes' : style.dim('—'),
    String(INDEX_SPECS[name]?.length ?? 0),
    String(uniqueSpecs.filter(([collection]) => collection === name).length || ''),
  ]),
);

if (dryRun) {
  console.log(
    style.dim(
      `\n--dry-run: nothing was applied. ${COLLECTION_NAMES.length} collections, ` +
        `${Object.values(INDEX_SPECS).flat().length} indexes, ${uniqueSpecs.length} of them unique.\n`,
    ),
  );
  process.exit(0);
}

const { db, close } = await connect(config);

try {
  heading('Validators');
  const validators = await applyValidators(db);
  console.log(
    `  applied ${style.green(String(validators.applied ?? 0))}` +
      (validators.failures?.length ? `, ${style.yellow(`${validators.failures.length} failed`)}` : ''),
  );
  for (const failure of validators.failures ?? []) {
    console.log(style.dim(`    ${typeof failure === 'string' ? failure : JSON.stringify(failure)}`));
  }

  heading('Indexes');
  const indexes = await ensureIndexes(db);
  console.log(`  created or confirmed ${style.green(String(indexes.created ?? 0))}`);

  const conflicts = indexes.conflicts ?? [];
  if (conflicts.length > 0) {
    console.log(style.yellow(`  ${conflicts.length} could not be applied:`));
    for (const conflict of conflicts) console.log(style.dim(`    ${conflict}`));

    const blockedUnique = conflicts.filter((conflict) =>
      uniqueSpecs.some(([collection, name]) => conflict.startsWith(`${collection}.${name}`)),
    );
    if (blockedUnique.length > 0) {
      console.error(
        style.red(
          `\n${blockedUnique.length} UNIQUE index could not be applied. The application will ` +
            'assume a constraint that the database is not enforcing.\n',
        ),
      );
      process.exit(4);
    }
  }

  console.log(style.green('\nDone.\n'));
} finally {
  await close();
}
