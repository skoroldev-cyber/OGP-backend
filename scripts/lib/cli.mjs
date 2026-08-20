import process from 'node:process';
import { MongoClient } from 'mongodb';

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

export function helpIfAsked(flags, usage) {
  if (flags.help || flags.h) {
    console.log(usage.trim());
    process.exit(0);
  }
}

const SUPPORTS_COLOUR = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (SUPPORTS_COLOUR ? `[${code}m${text}[0m` : text);

export const style = {
  dim: (text) => paint('2', text),
  bold: (text) => paint('1', text),
  green: (text) => paint('32', text),
  yellow: (text) => paint('33', text),
  red: (text) => paint('31', text),
};

export function heading(text) {
  console.log(`\n${style.bold(text)}`);
  console.log(style.dim('─'.repeat(Math.min(text.length, 78))));
}

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

export function refuseInProduction(config, what) {
  if (config.env === 'production') {
    console.error(style.red(`\nRefusing to ${what} with NODE_ENV=production.`));
    console.error(style.dim('  This guard is not overridable by a flag, on purpose.\n'));
    process.exit(3);
  }
}

export function fail(message, code = 1) {
  console.error(style.red(`\n${message}\n`));
  process.exit(code);
}
