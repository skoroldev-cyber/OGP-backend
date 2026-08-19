/**
 * Shared plumbing for the operational scripts.
 *
 * Every script in this directory is something an operator runs against a live database, often
 * for the first time, often at an awkward hour. So they all behave the same way: `--help`
 * works, `--dry-run` touches nothing, an unreachable database is a sentence rather than a
 * stack trace, and nothing prints a secret unless printing it is the whole point.
 *
 * @module scripts/lib/cli
 */

import process from 'node:process';
import { MongoClient } from 'mongodb';

/**
 * Parse `--key=value`, `--flag` and bare positionals.
 *
 * @param {string[]} [argv] Defaults to `process.argv.slice(2)`.
 * @returns {{ flags: Record<string, string|boolean>, positionals: string[] }} Parsed argv.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];

  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    if (equals === -1) flags[body] = true;
    else flags[body.slice(0, equals)] = body.slice(equals + 1);
  }

  return { flags, positionals };
}

/**
 * Print usage and exit 0 when `--help` is present.
 *
 * @param {Record<string, string|boolean>} flags Parsed flags.
 * @param {string} usage The usage text.
 * @returns {void}
 */
export function helpIfAsked(flags, usage) {
  if (flags.help || flags.h) {
    console.log(usage.trim());
    process.exit(0);
  }
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

const SUPPORTS_COLOUR = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (SUPPORTS_COLOUR ? `[${code}m${text}[0m` : text);

export const style = {
  dim: (text) => paint('2', text),
  bold: (text) => paint('1', text),
  green: (text) => paint('32', text),
  yellow: (text) => paint('33', text),
  red: (text) => paint('31', text),
};

/**
 * Print a heading with a rule beneath it.
 *
 * @param {string} text The heading.
 * @returns {void}
 */
export function heading(text) {
  console.log(`\n${style.bold(text)}`);
  console.log(style.dim('─'.repeat(Math.min(text.length, 78))));
}

/**
 * Render an aligned table. Columns are sized to their widest cell.
 *
 * @param {string[]} headers Column headers.
 * @param {Array<Array<string|number>>} rows Row cells.
 * @returns {void}
 */
export function table(headers, rows) {
  if (rows.length === 0) {
    console.log(style.dim('  (nothing)'));
    return;
  }

  const widths = headers.map((header, column) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[column] ?? '').length)),
  );
  const line = (cells) =>
    `  ${cells.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ')}`.trimEnd();

  console.log(style.dim(line(headers)));
  for (const row of rows) console.log(line(row));
}

/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Connect, prove the connection, and hand back a closer.
 *
 * A script that cannot reach the database says so in one sentence and exits 2 — an operator
 * reading a driver stack trace learns nothing they did not already suspect.
 *
 * @param {object} config The loaded application config.
 * @returns {Promise<{ client: MongoClient, db: import('mongodb').Db, close: () => Promise<void> }>} The handle.
 */
export async function connect(config) {
  const client = new MongoClient(config.mongo.uri, {
    serverSelectionTimeoutMS: 5000,
    appName: 'ogp-scripts',
  });

  try {
    await client.connect();
    await client.db(config.mongo.db).command({ ping: 1 });
  } catch (error) {
    const safeUri = config.mongo.uri.replace(/\/\/[^@]*@/, '//***@');
    console.error(style.red(`\nCannot reach MongoDB at ${safeUri}`));
    console.error(style.dim(`  ${error.message}`));
    console.error(style.dim('  Check MONGODB_URI, or start a local mongod, and try again.\n'));
    await client.close().catch(() => {});
    process.exit(2);
  }

  const db = client.db(config.mongo.db);
  return { client, db, close: () => client.close() };
}

/**
 * Refuse a destructive operation in production.
 *
 * @param {object} config The loaded application config.
 * @param {string} what A description of the operation, for the message.
 * @returns {void}
 */
export function refuseInProduction(config, what) {
  if (config.env === 'production') {
    console.error(style.red(`\nRefusing to ${what} with NODE_ENV=production.`));
    console.error(style.dim('  This guard is not overridable by a flag, on purpose.\n'));
    process.exit(3);
  }
}

/**
 * Exit with a message.
 *
 * @param {string} message The failure.
 * @param {number} [code] Exit code.
 * @returns {never}
 */
export function fail(message, code = 1) {
  console.error(style.red(`\n${message}\n`));
  process.exit(code);
}
