import { COLLECTIONS } from '../../db/collections.js';
import { ApiError } from '../../plugins/errors.js';

export const LISTABLE_PRODUCT_STATUSES = Object.freeze(['reservable', 'purchasable']);

export const LAUNCH_PRODUCT_SKU = 'hardcover-standard';

export function toPublicProduct(document) {
  return {
    sku: document.sku,
    type: document.type,
    title: document.title ?? document.name ?? null,
    edition: document.edition ?? null,
    priceCents: Number.isInteger(document.priceCents) ? document.priceCents : null,
    currency: typeof document.currency === 'string' ? document.currency : 'USD',
    status: document.status,
    shippingRequired: document.shippingRequired === true,
  };
}

export function isReservable(product) {
  if (!product || product.active === false) return false;
  if (product.reservable === false) return false;
  return LISTABLE_PRODUCT_STATUSES.includes(product.status);
}

export function isPurchasable(product, config) {
  if (config?.flags?.hardcoverPurchasable !== true) return false;
  if (!product || product.active === false) return false;
  if (product.purchasable === false) return false;
  if (product.status !== 'purchasable') return false;
  return Number.isInteger(product.priceCents) && product.priceCents > 0;
}

export function purchaseUnavailable() {
  return new ApiError(
    403,
    'PURCHASE_NOT_AVAILABLE',
    'The printed edition cannot be purchased yet. You may reserve a copy; nothing is charged for a reservation.',
  );
}

export function createProductsService({ db, config }) {
  const products = db.collection(COLLECTIONS.PRODUCTS);

  return {
    async listActive() {
      const documents = await products
        .find(
          { active: true, status: { $in: [...LISTABLE_PRODUCT_STATUSES] } },
          { sort: { sku: 1 }, limit: 100 },
        )
        .toArray();
      return { products: documents.map(toPublicProduct) };
    },

    async findBySku(sku) {
      if (typeof sku !== 'string' || sku === '') return null;
      return products.findOne({ sku });
    },

    async resolveForPurchase(sku) {
      const product = await this.findBySku(sku);
      if (!isPurchasable(product, config)) throw purchaseUnavailable();
      return product;
    },

    async resolveForReservation(sku) {
      const product = await this.findBySku(sku);
      if (!isReservable(product)) {
        throw new ApiError(404, 'PRODUCT_NOT_AVAILABLE', 'That edition is not available.');
      }
      return product;
    },

    amountFor(product, quantity) {
      return product.priceCents * quantity;
    },
  };
}

export default createProductsService;
