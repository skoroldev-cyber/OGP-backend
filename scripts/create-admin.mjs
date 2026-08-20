#!/usr/bin/env node
import process from 'node:process';

import config from '../src/config/index.js';
import { COLLECTIONS } from '../src/db/collections.js';
import { ADMIN_ROLES } from '../src/config/constants.js';
import { newId } from '../src/lib/ids.js';
import { checkPasswordStrength, hashPassword } from '../src/lib/hash.js';
import { buildOtpAuthUri, generateTotpSecret } from '../src/lib/totp.js';
import { connect, fail, heading, helpIfAsked, parseArgs, style } from './lib/cli.mjs';

const USAGE = `
create-admin — create an administrator with mandatory MFA

  ADMIN_PASSWORD='…' node scripts/create-admin.mjs --email=<address> --role=<role>

Options
  --email=<address>  Required.
  --role=<role>      Required. One of: ${ADMIN_ROLES.join(', ')}
  --force            Permit a second founder account.
  --help             This text.

The password comes from the ADMIN_PASSWORD environment variable, never from an argument —
arguments land in shell history and in the process table.

The TOTP secret is printed once and never again. Enrol it before closing the terminal.
`;

const { flags } = parseArgs();
helpIfAsked(flags, USAGE);

const email = typeof flags.email === 'string' ? flags.email.trim().toLowerCase() : null;
const role = typeof flags.role === 'string' ? flags.role.trim() : null;
const force = Boolean(flags.force);
const password = process.env.ADMIN_PASSWORD ?? '';

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('A valid --email is required.');
if (!role || !ADMIN_ROLES.includes(role)) {
  fail(`--role must be one of: ${ADMIN_ROLES.join(', ')}`);
}
if (!password) fail('Set ADMIN_PASSWORD in the environment. It is never read from an argument.');

const strength = checkPasswordStrength(password);
if (!strength.ok) fail(`Password rejected: ${strength.reason}`);

const { db, close } = await connect(config);

try {
  const admins = db.collection(COLLECTIONS.ADMIN_USERS);

  if (await admins.findOne({ email })) {
    fail(`An administrator already exists for ${email}.`, 6);
  }

  if (role === 'founder' && !force) {
    const existingFounder = await admins.findOne({ role: 'founder', active: true });
    if (existingFounder) {
      fail(
        'A founder account already exists. Two-person control (§9.2.10) assumes the founder ' +
          'role is singular.\n  Pass --force if a second is genuinely intended.',
        6,
      );
    }
  }

  const totpSecret = generateTotpSecret();
  const now = new Date();

  await admins.insertOne({
    _id: newId(),
    email,
    role,
    passwordHash: await hashPassword(password),
    mfa: {
      enabled: true,
      totpSecretEnc: totpSecret,
      enrolledAt: null,
    },
    active: true,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });

  heading('Administrator created');
  console.log(`  email  ${email}`);
  console.log(`  role   ${role}`);

  heading('Enrol MFA now — this is the only time it is shown');
  console.log(`  secret ${style.bold(totpSecret)}`);
  console.log(`  uri    ${style.dim(buildOtpAuthUri({ secret: totpSecret, accountName: email }))}`);

  console.log(
    style.yellow(
      '\nThe secret is not recoverable. If it is lost, delete the account and create it again.\n' +
        'Do not paste it into chat, a ticket, or a shared document — every credential that has\n' +
        'ever appeared in Slack is on the rotation list in the launch checklist.\n',
    ),
  );
} finally {
  await close();
}
