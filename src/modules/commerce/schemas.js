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

export const DONATION_KINDS = Object.freeze(['digital_transcript_access', 'support_mission']);

export const MINIMUM_DONATION_CENTS = 100;

export const MAX_ORDER_QUANTITY = 20;

export const DECLINE_REASONS = Object.freeze(['card_declined', 'card_not_accepted']);

export function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

export function toInteger(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback;
}

export const paymentToken = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9_.-]{8,256}$',
  minLength: 8,
  maxLength: 256,
});

export const signedToken = Object.freeze({
  type: 'string',
  pattern: '^v1\\.[A-Za-z0-9_-]{8,1024}\\.[A-Za-z0-9_-]{43}$',
  minLength: 32,
  maxLength: 1200,
});

export const receiptNumber = Object.freeze({
  type: 'string',
  pattern: '^OGP-[CS]-[0-9]{4}-[0-9]{6}$',
  minLength: 17,
  maxLength: 17,
});

export const productSku = Object.freeze({
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9-]{1,63}$',
  minLength: 2,
  maxLength: 64,
});

const quantity = Object.freeze({ type: 'integer', minimum: 1, maximum: MAX_ORDER_QUANTITY });

const donationAmountCents = Object.freeze({
  type: 'integer',
  minimum: MINIMUM_DONATION_CENTS,
  maximum: 100_000_000,
});

const publicProduct = objectSchema(
  {
    sku: productSku,
    type: boundedString(32, 1),
    title: { type: ['string', 'null'], maxLength: 200 },
    edition: { type: ['string', 'null'], maxLength: 120 },
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

const digitalAccess = objectSchema(
  {
    granted: { type: 'boolean' },
    url: boundedString(1024, 1),
  },
  { required: ['granted', 'url'], nullable: true },
);

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

export const paymentDeclinedResponse = objectSchema(
  {
    status: enumOf(['declined']),
    reason: enumOf(DECLINE_REASONS),
  },
  { required: ['status', 'reason'] },
);

export const freeAccessBody = objectSchema({ email }, { required: ['email'] });

export const digitalAccessResponse = objectSchema(
  { digitalAccess },
  { required: ['digitalAccess'] },
);

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

export const webhookHeaders = webhookSignatureHeader;

export const webhookBody = Object.freeze({ type: 'object' });

export const webhookResponse = objectSchema(
  {
    received: { type: 'boolean' },
    status: enumOf(['processed', 'skipped', 'ignored']),
  },
  { required: ['received', 'status'] },
);

export const commerceHeaders = sessionTokenHeader;

export const commerceIdentifier = identifier;

export const commerceIsoDate = isoDate;

export const commerceErrorResponses = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
