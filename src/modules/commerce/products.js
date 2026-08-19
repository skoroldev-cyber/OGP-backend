/**
 * The product catalog — workflow B (printed editions) only.
 *
 * The locked commerce rule governs this file as much as it governs the routes:
 *
 * > "Digital transcript access uses a donation workflow. Hardcover editions use a product
 * > purchase workflow. These remain separate throughout the platform."
 *
 * So the digital transcript is never sold here. There is no code path in this module that
 * can put transcript access into an order, and no code path in `donations.js` that can put
 * a product into a contribution. The two workflows share nothing but the gateway client.
 *
 * **No price exists anywhere in the corpus.** `priceCents` ships null and the purchase flow
 * cannot activate while it is null (§6.10). That gate lives here rather than in the route,
 * so a future caller cannot route around it by reaching the order service directly.
 */

import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

/** Catalog statuses a reader may see at all. `draft` and `retired` are internal. */
export const LISTABLE_PRODUCT_STATUSES = Object.freeze(['reservable', 'purchasable']);

/** The launch entry (§6.7). Seeded as data; never created by a request. */
export const LAUNCH_PRODUCT_SKU = 'hardcover-standard';

/** Everything a reader is told about a product. No cost basis, no stock count, no notes. */
export function toPublicProduct(document) {
  return {
    sku: document.sku,
    type: document.type,
    title: document.title ?? document.name ?? null,
    edition: document.edition ?? null,
    // Null is the honest answer until the founder sets a price. The frontend renders the
    // reserve path when it is null; it never invents a number.
    priceCents: Number.isInteger(document.priceCents) ? document.priceCents : null,
    currency: typeof document.currency === 'string' ? document.currency : 'USD',
    status: document.status,
    shippingRequired: document.shippingRequired === true,
  };
}

/**
 * Whether a product may be reserved. Reservation takes no payment and no deposit, so the
 * only requirements are that the record is live and the founder has opened the catalog
 * entry for it.
 *
 * @param {object|null} product A `products` document.
 * @returns {boolean} True when a reservation may be recorded.
 */
export function isReservable(product) {
  if (!product || product.active === false) return false;
  if (product.reservable === false) return false;
  return LISTABLE_PRODUCT_STATUSES.includes(product.status);
}

/**
 * Whether a product may be purchased right now. Three independent conditions, all of which
 * are founder-controlled and none of which this service may infer:
 *
 *   1. `HARDCOVER_PURCHASABLE` is on;
 *   2. the catalog entry is `purchasable` and live;
 *   3. a real price exists.
 *
 * @param {object|null} product A `products` document.
 * @param {object} config The application configuration.
 * @returns {boolean} True when a purchase may be taken.
 */
export function isPurchasable(product, config) {
  if (config?.flags?.hardcoverPurchasable !== true) return false;
  if (!product || product.active === false) return false;
  if (product.purchasable === false) return false;
  if (product.status !== 'purchasable') return false;
  return Number.isInteger(product.priceCents) && product.priceCents > 0;
}

/**
 * The refusal a reader sees when the printed edition cannot yet be bought.
 *
 * The wording states the fact and offers the alternative. It contains no deadline, no
 * scarcity claim and no encouragement to hurry — those are prohibited mechanics, and a
 * "not yet" is exactly where a commerce system is most tempted to reach for them.
 *
 * @returns {ApiError} A 403 with calm copy.
 */
export function purchaseUnavailable() {
  return new ApiError(
    403,
    'PURCHASE_NOT_AVAILABLE',
    'The printed edition cannot be purchased yet. You may reserve a copy; nothing is charged for a reservation.',
  );
}

/**
 * @param {{ db: import('mongodb').Db, config: object }} deps Dependencies.
 * @returns {object} The products service.
 */
export function createProductsService({ db, config }) {
  const products = db.collection(COLLECTIONS.PRODUCTS);

  return {
    /**
     * `GET /commerce/products`.
     *
     * @returns {Promise<{ products: object[] }>} The listable catalog.
     */
    async listActive() {
      const documents = await products
        .find(
          { active: true, status: { $in: [...LISTABLE_PRODUCT_STATUSES] } },
          { sort: { sku: 1 }, limit: 100 },
        )
        .toArray();
      return { products: documents.map(toPublicProduct) };
    },

    /**
     * @param {string} sku The catalog identifier.
     * @returns {Promise<object|null>} The document, or null.
     */
    async findBySku(sku) {
      if (typeof sku !== 'string' || sku === '') return null;
      return products.findOne({ sku });
    },

    /**
     * Resolve a product for a purchase, refusing unless every gate is open.
     *
     * @param {string} sku The catalog identifier.
     * @returns {Promise<object>} The product document.
     * @throws {ApiError} 403 when the purchase flow may not run for this product.
     */
    async resolveForPurchase(sku) {
      const product = await this.findBySku(sku);
      if (!isPurchasable(product, config)) throw purchaseUnavailable();
      return product;
    },

    /**
     * Resolve a product for a reservation.
     *
     * @param {string} sku The catalog identifier.
     * @returns {Promise<object>} The product document.
     * @throws {ApiError} 404 when the edition is not open for reservation.
     */
    async resolveForReservation(sku) {
      const product = await this.findBySku(sku);
      if (!isReservable(product)) {
        throw new ApiError(404, 'PRODUCT_NOT_AVAILABLE', 'That edition is not available.');
      }
      return product;
    },

    /**
     * Line amount for a quantity. Integer cents throughout — money is never a double.
     *
     * @param {object} product A purchasable product.
     * @param {number} quantity How many copies.
     * @returns {number} The total in cents.
     */
    amountFor(product, quantity) {
      return product.priceCents * quantity;
    },
  };
}

export default createProductsService;
