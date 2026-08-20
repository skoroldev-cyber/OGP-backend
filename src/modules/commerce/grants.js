import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { newId } from '../../lib/ids.js';
import { signAccessToken, verifyAccessToken, verifyReceiptToken } from '../../lib/tokens.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

export const RECEIPT_SERIES = Object.freeze({
  contribution: 'OGP-C',
  sale: 'OGP-S',
});

const SEQUENCE_DIGITS = 6;

const MAX_ALLOCATION_ATTEMPTS = 5;

export const MERCHANT = Object.freeze({
  name: 'One Global People',
  address: '37240 Felt Rd, New Boston, MI 48164',
});

export const TAX_STATEMENT = 'One Global People will provide tax documentation as applicable.';

export const PROVIDED_IN_RETURN = Object.freeze({
  digital_transcript_access: 'digital transcript access',
  support_mission: 'no goods or services were provided',
});

export const TRANSCRIPT = Object.freeze({
  title: 'Now or Never - One',
  subtitle: 'The Global Family Unites to Save the World',
  edition: 'Digital Transcript',
});

function grantUnavailable() {
  return new ApiError(404, 'ACCESS_NOT_AVAILABLE', 'That link is not available.');
}

function receiptUnavailable() {
  return new ApiError(404, 'RECEIPT_NOT_AVAILABLE', 'That receipt is not available.');
}

export async function nextReceiptNumber({ collection, series, field = 'receiptNumber', now = new Date() }) {
  const prefix = `${series}-${now.getUTCFullYear()}-`;
  const [latest] = await collection
    .find(
      { [field]: { $regex: `^${prefix}` } },
      { projection: { [field]: 1 }, sort: { [field]: -1 }, limit: 1 },
    )
    .toArray();

  const previous = latest ? Number(String(latest[field]).slice(prefix.length)) : 0;
  const sequence = Number.isInteger(previous) && previous >= 0 ? previous + 1 : 1;
  return `${prefix}${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`;
}

export async function assignReceiptNumber({
  collection,
  series,
  field = 'receiptNumber',
  id,
  now = new Date(),
  extraSet = {},
}) {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await nextReceiptNumber({ collection, series, field, now });
    try {
      await collection.updateOne(
        { _id: id },
        { $set: { [field]: candidate, ...extraSet, ...updateStamps(now) } },
      );
      return candidate;
    } catch (error) {
      if (error?.code === 11000 || error?.code === 11001) continue;
      throw error;
    }
  }
  throw new ApiError(
    503,
    'RECEIPT_NUMBER_UNAVAILABLE',
    'The record could not be completed. Nothing further was charged.',
  );
}

export function createGrantsService({ db, config, logger = null }) {
  const grants = db.collection(COLLECTIONS.DIGITAL_ACCESS_GRANTS);

  function accessUrl(token) {
    return `${config.origins.publicOrigin}/transcript/${token}`;
  }

  return {
    accessUrl,

    async mint({ donationId = null, email = null, grantType, now = new Date() }) {
      const grantId = newId();
      const token = signAccessToken({ grantId });
      await grants.insertOne({
        _id: grantId,
        donationId,
        email,
        token,
        grantType,
        revoked: false,
        revokedAt: null,
        lastAccessedAt: null,
        accessCount: 0,
        ...creationStamps(SCHEMA_VERSION, now),
      });
      return { grantId, token, url: accessUrl(token) };
    },

    async describe(grantId) {
      if (typeof grantId !== 'string' || grantId === '') return null;
      const grant = await grants.findOne(
        { _id: grantId },
        { projection: { token: 1, revoked: 1 } },
      );
      if (!grant || grant.revoked === true) return null;
      return { granted: true, url: accessUrl(grant.token) };
    },

    async manifest(accessToken) {
      const verified = verifyAccessToken(accessToken);
      if (!verified.valid) throw grantUnavailable();

      const now = new Date();
      const grant = await grants.findOneAndUpdate(
        { _id: verified.grantId, token: accessToken, revoked: false },
        [
          {
            $set: {
              accessCount: { $add: [{ $ifNull: ['$accessCount', 0] }, 1] },
              lastAccessedAt: now,
              updatedAt: now,
            },
          },
        ],
        { returnDocument: 'after', projection: { grantType: 1, createdAt: 1 } },
      );
      if (!grant) throw grantUnavailable();

      return {
        access: {
          granted: true,
          grantType: grant.grantType,
          issuedAt: toIso(grant.createdAt),
        },
        transcript: {
          title: TRANSCRIPT.title,
          subtitle: TRANSCRIPT.subtitle,
          edition: TRANSCRIPT.edition,
          readingUrl: `${config.origins.publicOrigin}/reading-room`,
        },
      };
    },

    async revokeForDonation(donationId, options = {}) {
      const now = options.now ?? new Date();
      const result = await grants.updateMany(
        { donationId, revoked: false },
        { $set: { revoked: true, revokedAt: now, ...updateStamps(now) } },
      );
      if ((result.modifiedCount ?? 0) > 0) {
        logger?.info?.({ donationId }, 'transcript access revoked by administrator request');
      }
      return result.modifiedCount ?? 0;
    },
  };
}

export function createReceiptsService({ db }) {
  const donations = db.collection(COLLECTIONS.DONATIONS);
  const orders = db.collection(COLLECTIONS.ORDERS);

  function paymentMethod(nmi) {
    if (!nmi) return null;
    const brand = typeof nmi.cardBrand === 'string' && nmi.cardBrand !== '' ? nmi.cardBrand : null;
    const last4 = typeof nmi.last4 === 'string' && nmi.last4 !== '' ? nmi.last4 : null;
    if (brand && last4) return `${brand} ending ${last4}`;
    if (last4) return `Card ending ${last4}`;
    return brand;
  }

  function refundLines(refunds) {
    if (!Array.isArray(refunds)) return [];
    return refunds.map((entry) => ({
      amountCents: Number.isInteger(entry.amountCents) ? entry.amountCents : 0,
      at: toIso(entry.at),
    }));
  }

  return {
    async view({ receiptNumber, token }) {
      if (!verifyReceiptToken(token, receiptNumber).valid) throw receiptUnavailable();

      if (receiptNumber.startsWith(`${RECEIPT_SERIES.contribution}-`)) {
        const donation = await donations.findOne({ receiptNumber });
        if (!donation) throw receiptUnavailable();
        return {
          receipt: {
            receiptNumber,
            workflow: 'contribution',
            issuedAt: toIso(donation.capturedAt ?? donation.createdAt),
            status: donation.status,
            amountCents: donation.amountCents,
            currency: donation.currency ?? 'USD',
            paymentMethod: paymentMethod(donation.nmi),
            providedInReturn: PROVIDED_IN_RETURN[donation.kind] ?? null,
            lineItems: [],
            shippingAddress: null,
            refunds: refundLines(donation.refunds),
            merchant: { name: MERCHANT.name, address: MERCHANT.address },
            taxStatement: TAX_STATEMENT,
          },
        };
      }

      if (receiptNumber.startsWith(`${RECEIPT_SERIES.sale}-`)) {
        const order = await orders.findOne({
          $or: [{ receiptNumber }, { orderNumber: receiptNumber }],
        });
        if (!order) throw receiptUnavailable();
        const address = order.shippingAddress ?? null;
        return {
          receipt: {
            receiptNumber,
            workflow: 'sale',
            issuedAt: toIso(order.paidAt ?? order.createdAt),
            status: order.status,
            amountCents: Number.isInteger(order.amountCents) ? order.amountCents : 0,
            currency: order.currency ?? 'USD',
            paymentMethod: paymentMethod(order.nmi),
            providedInReturn: null,
            lineItems: [
              {
                description: order.productSku,
                quantity: Number.isInteger(order.quantity) ? order.quantity : 1,
                amountCents: Number.isInteger(order.amountCents) ? order.amountCents : 0,
              },
            ],
            shippingAddress: address
              ? {
                  name: address.name ?? null,
                  line1: address.line1 ?? null,
                  line2: address.line2 ?? null,
                  city: address.city ?? null,
                  region: address.region ?? null,
                  postalCode: address.postalCode ?? null,
                  country: address.country ?? null,
                }
              : null,
            refunds: refundLines(order.refunds),
            merchant: { name: MERCHANT.name, address: MERCHANT.address },
            taxStatement: TAX_STATEMENT,
          },
        };
      }

      throw receiptUnavailable();
    },
  };
}

export default createGrantsService;
