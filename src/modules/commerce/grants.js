/**
 * Digital access grants, receipt numbering and receipt retrieval.
 *
 * ## Grants
 *
 * A grant is access without an account. The token is a signed, non-expiring value
 * (`lib/tokens.js`), the URL works without a login, and revocation is a database flag
 * rather than a clock — §6.6 requires exactly that, and it is also the only shape that
 * honours "no account required to read".
 *
 * A grant is minted by the *donation* workflow or by the free-access path. Nothing in the
 * product purchase workflow can mint one: the two workflows stay separate at every layer.
 *
 * ## Two numbering series that never interleave
 *
 * Contributions are numbered `OGP-C-YYYY-######` and sales/reservations `OGP-S-YYYY-######`
 * (§6.12). They are separate monotonic series over separate collections, because the
 * merchant account is MCC 8398 (charity) while printed-edition sales are product revenue —
 * commingling them is an accounting and card-network misclassification risk, not a
 * cosmetic concern (§6.4, §6.13).
 *
 * Allocation reads the highest existing number in the series for the current year and adds
 * one, then relies on the unique index to arbitrate a race and retries. There is no counter
 * document, because `db/collections.js` is a closed registry and a counter collection would
 * have to be invented; the retry loop costs one extra query in the rare collision case.
 *
 * ## Receipt retrieval
 *
 * `GET /commerce/receipts/:receiptNumber?t=…` is accountless and signature-verified. The
 * prefix of the receipt number decides which collection is read — a contribution receipt
 * never queries `orders` and a sales receipt never queries `donations`. An invalid
 * signature and an unknown number produce the identical calm 404, so the endpoint cannot be
 * used to discover which receipts exist.
 */

import { SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps, updateStamps } from '../../db/collections.js';
import { newId } from '../../lib/ids.js';
import { signAccessToken, verifyAccessToken, verifyReceiptToken } from '../../lib/tokens.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

/** The two receipt series. They are never merged, never interleaved, never renumbered. */
export const RECEIPT_SERIES = Object.freeze({
  contribution: 'OGP-C',
  sale: 'OGP-S',
});

/** Sequence width inside a series, per §6.12: `OGP-C-2026-000001`. */
const SEQUENCE_DIGITS = 6;

/** How many times an allocation may lose a race before it gives up. */
const MAX_ALLOCATION_ATTEMPTS = 5;

/** Merchant identity printed on every receipt (§6.5.2, §6.12). */
export const MERCHANT = Object.freeze({
  name: 'One Global People',
  address: '37240 Felt Rd, New Boston, MI 48164',
});

/**
 * Until counsel confirms 501(c)(3) status, a receipt may not claim deductibility (§6.13.3).
 * This sentence is the placeholder the corpus specifies, verbatim.
 */
export const TAX_STATEMENT = 'One Global People will provide tax documentation as applicable.';

/** What a contribution receives in return, stated plainly on the receipt (§6.12). */
export const PROVIDED_IN_RETURN = Object.freeze({
  digital_transcript_access: 'digital transcript access',
  support_mission: 'no goods or services were provided',
});

/** The transcript a grant opens. Titles are the locked book strings. */
export const TRANSCRIPT = Object.freeze({
  title: 'Now or Never - One',
  subtitle: 'The Global Family Unites to Save the World',
  edition: 'Digital Transcript',
});

/** A grant that cannot be resolved answers exactly like one that never existed. */
function grantUnavailable() {
  return new ApiError(404, 'ACCESS_NOT_AVAILABLE', 'That link is not available.');
}

/** Identical refusal for a bad signature, an unknown number and a mismatched pair. */
function receiptUnavailable() {
  return new ApiError(404, 'RECEIPT_NOT_AVAILABLE', 'That receipt is not available.');
}

/**
 * The next unused number in a series, for the current calendar year.
 *
 * @param {{ collection: import('mongodb').Collection, series: string, field?: string,
 *           now?: Date }} input Allocation input.
 * @returns {Promise<string>} A candidate number. Uniqueness is settled by the index.
 */
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

/**
 * Allocate a number and write it onto a record, retrying when another writer wins the race.
 *
 * @param {{ collection: import('mongodb').Collection, series: string, field?: string,
 *           id: string, now?: Date, extraSet?: object }} input Assignment input.
 * @returns {Promise<string>} The number written.
 * @throws {ApiError} 503 when the series could not be advanced.
 */
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

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object }} deps Dependencies.
 * @returns {object} The grants service.
 */
export function createGrantsService({ db, config, logger = null }) {
  const grants = db.collection(COLLECTIONS.DIGITAL_ACCESS_GRANTS);

  /**
   * The reader-facing URL for a grant token.
   *
   * @param {string} token The signed access token.
   * @returns {string} The absolute URL.
   */
  function accessUrl(token) {
    return `${config.origins.publicOrigin}/transcript/${token}`;
  }

  return {
    accessUrl,

    /**
     * Mint a grant. The identifier is generated first so the token can carry it, which is
     * what makes the token verifiable without a database round trip and revocable with one.
     *
     * @param {{ donationId?: string|null, email?: string|null,
     *           grantType: 'contribution'|'free_access', now?: Date }} input Grant input.
     * @returns {Promise<{ grantId: string, token: string, url: string }>} The grant.
     */
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

    /**
     * @param {string|null} grantId A grant identifier.
     * @returns {Promise<{ granted: boolean, url: string }|null>} The access descriptor.
     */
    async describe(grantId) {
      if (typeof grantId !== 'string' || grantId === '') return null;
      const grant = await grants.findOne(
        { _id: grantId },
        { projection: { token: 1, revoked: 1 } },
      );
      if (!grant || grant.revoked === true) return null;
      return { granted: true, url: accessUrl(grant.token) };
    },

    /**
     * `GET /transcript/:accessToken`.
     *
     * A valid signature is necessary and never sufficient: the grant is re-read and the
     * revocation flag is honoured. `accessCount` is a private operational number and is
     * never returned — a reader is not shown a count of anything.
     *
     * @param {string} accessToken The signed token from the URL.
     * @returns {Promise<object>} The access manifest.
     * @throws {ApiError} 404 when the token is unusable or the grant is revoked.
     */
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

    /**
     * Revoke every grant attached to a contribution. Used only by an administrator acting
     * on a refund explicitly reported as made in error — a goodwill refund leaves access
     * intact by default (§6.8), and a chargeback never revokes anything automatically.
     *
     * @param {string} donationId The contribution identifier.
     * @param {{ now?: Date }} [options] Timestamp override.
     * @returns {Promise<number>} How many grants were revoked.
     */
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

/**
 * @param {{ db: import('mongodb').Db }} deps Dependencies.
 * @returns {object} The receipts service.
 */
export function createReceiptsService({ db }) {
  const donations = db.collection(COLLECTIONS.DONATIONS);
  const orders = db.collection(COLLECTIONS.ORDERS);

  /**
   * Payment method as it may appear on a receipt: brand and last four digits, never more.
   *
   * @param {object|null} nmi The stored gateway result.
   * @returns {string|null} A display string, or null when nothing is known.
   */
  function paymentMethod(nmi) {
    if (!nmi) return null;
    const brand = typeof nmi.cardBrand === 'string' && nmi.cardBrand !== '' ? nmi.cardBrand : null;
    const last4 = typeof nmi.last4 === 'string' && nmi.last4 !== '' ? nmi.last4 : null;
    if (brand && last4) return `${brand} ending ${last4}`;
    if (last4) return `Card ending ${last4}`;
    return brand;
  }

  /**
   * @param {Array<object>|undefined} refunds Stored refund entries.
   * @returns {Array<{ amountCents: number, at: string|null }>} The receipt-safe view.
   */
  function refundLines(refunds) {
    if (!Array.isArray(refunds)) return [];
    return refunds.map((entry) => ({
      amountCents: Number.isInteger(entry.amountCents) ? entry.amountCents : 0,
      at: toIso(entry.at),
    }));
  }

  return {
    /**
     * Render one receipt.
     *
     * @param {{ receiptNumber: string, token: string }} input The URL parts.
     * @returns {Promise<{ receipt: object }>} The receipt view.
     * @throws {ApiError} 404 for any failure, of any kind.
     */
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
