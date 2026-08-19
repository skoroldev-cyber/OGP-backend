/**
 * Commerce route schemas.
 *
 * Three properties of this file are load-bearing rather than cosmetic:
 *
 * 1. **No request schema anywhere in this module accepts card data.** There is no
 *    `cardNumber`, no `expiry`, no `cvv`, and with `additionalProperties: false` a client
 *    that sends one receives a `400` instead of having it quietly dropped. The browser
 *    tokenises through Collect.js and this service only ever sees a single-use
 *    `paymentToken` — which is what keeps the platform SAQ-A eligible (§6.13.1).
 * 2. **The donation shapes and the order shapes have nothing in common.** They share no
 *    fragment, no envelope and no response type. A contribution can never carry a product
 *    line and an order can never carry a contribution: the locked separation of the two
 *    workflows is expressed here as two disjoint vocabularies, not as a runtime check.
 * 3. **No response carries a count of other people.** No goal total, no supporter count, no
 *    "others also contributed" — those are social-proof indicators, and the surest way to
 *    keep them out of the UI is to give the UI no field to render.
 *
 * This file also holds the two projection helpers the shapes above are fed with, so a Date
 * or a missing value is normalised in exactly one place.
 */

import {
  amountCents as amountCentsSchema,
  arraySchema,
  boundedString,
  currency,
  email,
  enumOf,
  errorResponses,
  identifier,
  idempotencyKey,
  isoDate,
  objectSchema,
  sessionTokenHeader,
  shippingAddress,
  ulid,
  webhookSignatureHeader,
} from '../../lib/schemas.js';

/* -------------------------------------------------------------------------- */
/* Vocabularies and thresholds                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The two contribution kinds (§6.9, BUILD_CONTRACT §4.4). Pathway 2 attaches transcript
 * access; pathway 5 attaches nothing and says so plainly.
 */
export const DONATION_KINDS = Object.freeze(['digital_transcript_access', 'support_mission']);

/**
 * The minimum card amount, in cents. The corpus contains no dollar figure at all; §6.6
 * proposes $1.00 as the floor and the founder may raise it through
 * `config.commerce.minimumDonationCents` without a deployment. It is a floor, never a
 * suggestion: no amount is highlighted, no amount is preselected, and a one-dollar
 * contribution receives exactly the acknowledgment a thousand-dollar one receives.
 */
export const MINIMUM_DONATION_CENTS = 100;

/** Largest quantity a single order or reservation may carry. */
export const MAX_ORDER_QUANTITY = 20;

/**
 * Why a payment did not complete. Deliberately coarse: the reader is told the payment did
 * not go through and that nothing was charged, never a gateway diagnostic they cannot act
 * on and an attacker could probe with.
 */
export const DECLINE_REASONS = Object.freeze(['card_declined', 'card_not_accepted']);

/* -------------------------------------------------------------------------- */
/* Projection helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a stored timestamp for the wire.
 *
 * @param {unknown} value A Date, an ISO string, or nothing.
 * @returns {string|null} An ISO-8601 string, or null.
 */
export function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

/**
 * Normalise an integer for the wire.
 *
 * @param {unknown} value A candidate number.
 * @param {number|null} [fallback] Value to use when the candidate is not an integer.
 * @returns {number|null} The integer, or the fallback.
 */
export function toInteger(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Primitive fragments                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A Collect.js single-use payment token. Opaque to this service: it is forwarded to the
 * gateway and never stored, never logged, never echoed back.
 */
export const paymentToken = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_.-]{8,256}$',
  minLength: 8,
  maxLength: 256,
});

/** A signed token produced by `lib/tokens.js`: `v1.<payload>.<signature>`. */
export const signedToken = Object.freeze({
  type: 'string',
  pattern: '^v1\\.[A-Za-z0-9_-]{8,1024}\\.[A-Za-z0-9_-]{43}$',
  minLength: 32,
  maxLength: 1200,
});

/** `OGP-C-YYYY-######` or `OGP-S-YYYY-######`. The prefix selects the workflow. */
export const receiptNumber = Object.freeze({
  type: 'string',
  pattern: '^OGP-[CS]-[0-9]{4}-[0-9]{6}$',
  minLength: 17,
  maxLength: 17,
});

/** A catalog identifier. */
export const productSku = Object.freeze({
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9-]{1,63}$',
  minLength: 2,
  maxLength: 64,
});

const quantity = Object.freeze({ type: 'integer', minimum: 1, maximum: MAX_ORDER_QUANTITY });

/** The contribution amount. Donor-chosen, with a floor and a sane ceiling. */
const donationAmountCents = Object.freeze({
  type: 'integer',
  minimum: MINIMUM_DONATION_CENTS,
  maximum: 100_000_000,
});

/* -------------------------------------------------------------------------- */
/* Products (workflow B)                                                       */
/* -------------------------------------------------------------------------- */

const publicProduct = objectSchema(
  {
    sku: productSku,
    type: boundedString(32, 1),
    title: { type: ['string', 'null'], maxLength: 200 },
    edition: { type: ['string', 'null'], maxLength: 120 },
    // Null until the founder sets a price. The absence is part of the contract.
    priceCents: { type: ['integer', 'null'], minimum: 0, maximum: 100_000_000 },
    currency,
    status: enumOf(['reservable', 'purchasable']),
    shippingRequired: { type: 'boolean' },
  },
  { required: ['sku', 'type', 'priceCents', 'currency', 'status', 'shippingRequired'] },
);

export const productsResponse = objectSchema(
  { products: arraySchema(publicProduct, { maxItems: 100 }) },
  { required: ['products'] },
);

/* -------------------------------------------------------------------------- */
/* Donations (workflow A)                                                      */
/* -------------------------------------------------------------------------- */

/** What a reader is handed after a contribution that opens the transcript. */
const digitalAccess = objectSchema(
  {
    granted: { type: 'boolean' },
    url: boundedString(1024, 1),
  },
  { required: ['granted', 'url'], nullable: true },
);

/**
 * `POST /commerce/donations`.
 *
 * `email` is optional: a contribution may be entirely anonymous, and requiring an address
 * to give would be a data grab. Without one there is no receipt email and no delivery
 * email — the grant URL is returned in the response and shown on screen instead.
 */
export const createDonationBody = objectSchema(
  {
    kind: enumOf(DONATION_KINDS),
    amountCents: donationAmountCents,
    currency,
    paymentToken,
    email,
    anonymous: { type: 'boolean' },
    idempotencyKey,
  },
  { required: ['kind', 'amountCents', 'paymentToken', 'idempotencyKey'] },
);

export const donationCreatedResponse = objectSchema(
  {
    donationId: ulid,
    status: enumOf(['captured']),
    receiptNumber,
    digitalAccess,
  },
  { required: ['donationId', 'status', 'receiptNumber'] },
);

/**
 * The 402. Not an error envelope: a decline is an ordinary outcome of a payment attempt,
 * and the copy that renders it says plainly that nothing was charged.
 */
export const paymentDeclinedResponse = objectSchema(
  {
    status: enumOf(['declined']),
    reason: enumOf(DECLINE_REASONS),
  },
  { required: ['status', 'reason'] },
);

/** `POST /commerce/donations/free-access` — one address, nothing else, no questions. */
export const freeAccessBody = objectSchema({ email }, { required: ['email'] });

export const digitalAccessResponse = objectSchema(
  { digitalAccess },
  { required: ['digitalAccess'] },
);

/* -------------------------------------------------------------------------- */
/* Orders and reservations (workflow B)                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /commerce/orders`. A shipping address is collected because a physical object has
 * to reach a physical place, and for AVS; §6.5.3 forbids adding address fields to a
 * contribution for the same purpose, which is why this fragment appears in no donation
 * schema.
 */
export const createOrderBody = objectSchema(
  {
    productSku,
    quantity,
    email,
    shippingAddress,
    paymentToken,
    idempotencyKey,
  },
  { required: ['productSku', 'quantity', 'email', 'shippingAddress', 'paymentToken', 'idempotencyKey'] },
);

export const orderCreatedResponse = objectSchema(
  {
    orderId: ulid,
    orderNumber: receiptNumber,
    status: enumOf(['paid']),
    receiptNumber,
  },
  { required: ['orderId', 'orderNumber', 'status', 'receiptNumber'] },
);

/** `POST /commerce/reservations`. Email and quantity. No payment, no deposit, no card. */
export const createReservationBody = objectSchema(
  {
    productSku,
    quantity,
    email,
  },
  { required: ['productSku', 'quantity', 'email'] },
);

export const reservationCreatedResponse = objectSchema(
  {
    reservationId: ulid,
    status: enumOf(['reserved']),
  },
  { required: ['reservationId', 'status'] },
);

/* -------------------------------------------------------------------------- */
/* Receipts and transcript access                                              */
/* -------------------------------------------------------------------------- */

export const receiptParams = objectSchema({ receiptNumber }, { required: ['receiptNumber'] });

export const receiptQuery = objectSchema({ t: signedToken }, { required: ['t'] });

const receiptLineItem = objectSchema(
  {
    description: boundedString(200, 1),
    quantity: { type: 'integer', minimum: 1, maximum: MAX_ORDER_QUANTITY },
    amountCents: amountCentsSchema,
  },
  { required: ['description', 'quantity', 'amountCents'] },
);

const receiptRefundLine = objectSchema(
  {
    amountCents: amountCentsSchema,
    at: { type: ['string', 'null'], format: 'date-time' },
  },
  { required: ['amountCents', 'at'] },
);

const receiptShippingAddress = objectSchema(
  {
    name: { type: ['string', 'null'], maxLength: 120 },
    line1: { type: ['string', 'null'], maxLength: 160 },
    line2: { type: ['string', 'null'], maxLength: 160 },
    city: { type: ['string', 'null'], maxLength: 80 },
    region: { type: ['string', 'null'], maxLength: 80 },
    postalCode: { type: ['string', 'null'], maxLength: 24 },
    country: { type: ['string', 'null'], maxLength: 2 },
  },
  { nullable: true },
);

/**
 * One receipt. `workflow` names which ledger the row belongs to and is the field that keeps
 * a bookkeeper from ever having to guess — contribution income and sales revenue are
 * separate ledgers (§6.4, §6.12).
 */
export const receiptResponse = objectSchema(
  {
    receipt: objectSchema(
      {
        receiptNumber,
        workflow: enumOf(['contribution', 'sale']),
        issuedAt: { type: ['string', 'null'], format: 'date-time' },
        status: boundedString(32, 1),
        amountCents: amountCentsSchema,
        currency,
        paymentMethod: { type: ['string', 'null'], maxLength: 64 },
        providedInReturn: { type: ['string', 'null'], maxLength: 200 },
        lineItems: arraySchema(receiptLineItem, { maxItems: 20 }),
        shippingAddress: receiptShippingAddress,
        refunds: arraySchema(receiptRefundLine, { maxItems: 50 }),
        merchant: objectSchema(
          { name: boundedString(120, 1), address: boundedString(200, 1) },
          { required: ['name', 'address'] },
        ),
        taxStatement: boundedString(300, 1),
      },
      {
        required: [
          'receiptNumber',
          'workflow',
          'issuedAt',
          'status',
          'amountCents',
          'currency',
          'lineItems',
          'refunds',
          'merchant',
          'taxStatement',
        ],
      },
    ),
  },
  { required: ['receipt'] },
);

export const transcriptParams = objectSchema(
  { accessToken: signedToken },
  { required: ['accessToken'] },
);

/**
 * The grant manifest. It reports what the holder may open — never how many times they have
 * opened it, and never anything about anybody else.
 */
export const transcriptResponse = objectSchema(
  {
    access: objectSchema(
      {
        granted: { type: 'boolean' },
        grantType: enumOf(['contribution', 'free_access']),
        issuedAt: { type: ['string', 'null'], format: 'date-time' },
      },
      { required: ['granted', 'grantType', 'issuedAt'] },
    ),
    transcript: objectSchema(
      {
        title: boundedString(200, 1),
        subtitle: boundedString(200, 1),
        edition: boundedString(120, 1),
        readingUrl: boundedString(1024, 1),
      },
      { required: ['title', 'subtitle', 'edition', 'readingUrl'] },
    ),
  },
  { required: ['access', 'transcript'] },
);

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                    */
/* -------------------------------------------------------------------------- */

export const webhookHeaders = webhookSignatureHeader;

/**
 * The gateway owns this shape, so it is deliberately left open — the same decision, for the
 * same reason, as the event envelope's `payload` in `lib/schemas.js`. Closing it would turn
 * any field NMI adds into an outage, and the real gate is the HMAC over the raw bytes, not
 * a property list. Everything stored from it is redacted first.
 */
export const webhookBody = Object.freeze({ type: 'object' });

export const webhookResponse = objectSchema(
  {
    received: { type: 'boolean' },
    status: enumOf(['processed', 'skipped', 'ignored']),
  },
  { required: ['received', 'status'] },
);

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

export const commerceHeaders = sessionTokenHeader;

/** `identifier` is re-exported so route files import one vocabulary, not two. */
export const commerceIdentifier = identifier;

/** ISO date fragment, re-exported for the same reason. */
export const commerceIsoDate = isoDate;

export const commerceErrorResponses = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
