#!/usr/bin/env node
/**
 * Export the donation and order ledgers — separately, always.
 *
 * §6.4 is explicit: "Digital transcript access uses a donation workflow. Hardcover editions use
 * a product purchase workflow. These remain separate throughout the platform." Separation is
 * not a preference here. The Payarc merchant account is MCC 8398 — charitable — while hardcover
 * sales are product revenue, and commingling them creates a tax and card-network
 * misclassification problem that is far easier to avoid than to unwind.
 *
 * So this writes two files with two column sets and two numbering series, and there is no flag
 * that merges them.
 *
 * No card data is exported, because none exists to export: the platform never sees a card
 * number. The NMI transaction id is the only gateway reference, and it is the one an accountant
 * or a dispute response actually needs.
 *
 * Usage:
 *   node scripts/export-ledger.mjs [--from=2026-01-01] [--to=2026-12-31] [--out=./exports]
 *
 * @module scripts/export-ledger
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import config from '../src/config/index.js';
import { COLLECTIONS } from '../src/db/collections.js';
import { connect, fail, heading, helpIfAsked, parseArgs, style } from './lib/cli.mjs';

const USAGE = `
export-ledger — export the donation and order ledgers as separate CSV files

  node scripts/export-ledger.mjs [options]

Options
  --from=<YYYY-MM-DD>  Inclusive start. Default: the beginning.
  --to=<YYYY-MM-DD>    Exclusive end. Default: now.
  --out=<dir>          Output directory. Default: ./exports
  --help               This text.

Two files are always written. There is no flag that merges them: the merchant account is
MCC 8398 (charitable) and hardcover sales are product revenue, so the ledgers must never
commingle (§6.4, §6.13).

No card data is exported. The platform never holds any.
`;

const { flags } = parseArgs();
helpIfAsked(flags, USAGE);

/**
 * Parse a `YYYY-MM-DD` boundary.
 *
 * @param {unknown} value The flag value.
 * @param {string} label For the error message.
 * @returns {Date|null} The date, or null when absent.
 */
function parseDate(value, label) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) fail(`--${label} must be YYYY-MM-DD, got "${value}".`);
  return parsed;
}

const from = parseDate(flags.from, 'from');
const to = parseDate(flags.to, 'to');
const outDir = typeof flags.out === 'string' ? flags.out : path.join(process.cwd(), 'exports');

/** Quote a CSV cell per RFC 4180. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render rows to CSV text with a trailing newline. */
const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';

/** Cents to a plain decimal string — never a float in a ledger. */
const money = (cents) =>
  typeof cents === 'number' ? `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}` : '';

const dateFilter = {};
if (from) dateFilter.$gte = from;
if (to) dateFilter.$lt = to;
const filter = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};

const { db, close } = await connect(config);

try {
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = `${from ? from.toISOString().slice(0, 10) : 'start'}_${to ? to.toISOString().slice(0, 10) : 'now'}`;

  /* ---------------------------------------------------------------- */
  /* Donations — charitable receipts, MCC 8398                         */
  /* ---------------------------------------------------------------- */

  const donations = await db
    .collection(COLLECTIONS.DONATIONS)
    .find(filter, { sort: { createdAt: 1 } })
    .toArray();

  const donationHeaders = [
    'receipt_number',
    'donation_id',
    'received_at',
    'purpose',
    'amount_usd',
    'currency',
    'status',
    'nmi_transaction_id',
    'auth_code',
    'anonymous',
    'transcript_granted',
    'refunded_amount_usd',
  ];

  const donationRows = donations.map((donation) => [
    donation.receiptNumber ?? '',
    donation._id,
    donation.createdAt,
    donation.purpose ?? donation.kind ?? '',
    money(donation.amountCents),
    donation.currency ?? 'USD',
    donation.status ?? '',
    donation.nmi?.transactionId ?? '',
    donation.nmi?.authCode ?? '',
    donation.anonymous === true ? 'yes' : 'no',
    donation.transcriptGrant?.accessToken ? 'yes' : 'no',
    money((donation.refunds ?? []).reduce((total, refund) => total + (refund.amountCents ?? 0), 0)),
  ]);

  const donationFile = path.join(outDir, `donations_${stamp}.csv`);
  fs.writeFileSync(donationFile, toCsv(donationHeaders, donationRows), 'utf8');

  /* ---------------------------------------------------------------- */
  /* Orders — product revenue, a different ledger entirely             */
  /* ---------------------------------------------------------------- */

  const orders = await db
    .collection(COLLECTIONS.ORDERS)
    .find(filter, { sort: { createdAt: 1 } })
    .toArray();

  const orderHeaders = [
    'order_number',
    'order_id',
    'placed_at',
    'product_sku',
    'mode',
    'quantity',
    'amount_usd',
    'currency',
    'status',
    'nmi_transaction_id',
    'shipping_country',
    'refunded_amount_usd',
  ];

  const orderRows = orders.map((order) => [
    order.orderNumber ?? '',
    order._id,
    order.createdAt,
    order.productSku ?? order.productId ?? '',
    order.mode ?? '',
    order.quantity ?? 1,
    money(order.amountCents),
    order.currency ?? 'USD',
    order.status ?? '',
    order.nmi?.transactionId ?? '',
    // The shipping country is needed for tax and freight. The street address is not, and is
    // not exported.
    order.customer?.shippingAddress?.country ?? '',
    money((order.refunds ?? []).reduce((total, refund) => total + (refund.amountCents ?? 0), 0)),
  ]);

  const orderFile = path.join(outDir, `orders_${stamp}.csv`);
  fs.writeFileSync(orderFile, toCsv(orderHeaders, orderRows), 'utf8');

  /* ---------------------------------------------------------------- */

  const sum = (rows, column) =>
    rows.reduce((total, row) => total + Number.parseFloat(row[column] || '0'), 0).toFixed(2);

  heading('Exported');
  console.log(`  donations   ${String(donationRows.length).padStart(5)}  USD ${sum(donationRows, 4)}`);
  console.log(`              ${style.dim(donationFile)}`);
  console.log(`  orders      ${String(orderRows.length).padStart(5)}  USD ${sum(orderRows, 6)}`);
  console.log(`              ${style.dim(orderFile)}`);

  console.log(
    style.yellow(
      '\nThese two files are separate ledgers and must stay separate in bookkeeping:\n' +
        '  · donations are charitable receipts under MCC 8398\n' +
        '  · orders are product revenue\n' +
        'Neither file contains card data. The platform never holds any.\n',
    ),
  );
} finally {
  await close();
}
