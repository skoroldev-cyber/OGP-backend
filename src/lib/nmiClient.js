/**
 * NMI Payment API client.
 *
 * Card data never reaches this service. The browser tokenises through Collect.js hosted
 * fields and hands us a single-use `payment_token`; everything below posts that token,
 * an amount and an order reference to `https://secure.nmi.com/api/transact.php` as
 * `application/x-www-form-urlencoded` (§6.5.3). That keeps the platform SAQ-A eligible.
 *
 * Two rules are absolute:
 *  1. The security key is never logged, never returned, never placed in an error message.
 *  2. No PAN, expiry or CVV may be passed through this client at all — if a caller
 *     supplies one, the request is refused rather than forwarded.
 *
 * NMI's `response` field is `1` approved, `2` declined, `3` error. Callers should branch on
 * the normalised `status`, not on the raw code.
 */

import { randomBytes } from 'node:crypto';
import config from '../config/index.js';

/** Fields that must never leave this process in a log line. */
const NEVER_LOG = new Set([
  'security_key',
  'payment_token',
  'ccnumber',
  'ccexp',
  'cvv',
  'checkaba',
  'checkaccount',
  'customer_vault_id',
]);

/** Fields that must never be accepted from a caller — raw card data. */
const REFUSED_FIELDS = ['ccnumber', 'ccexp', 'cvv', 'card_number', 'cardNumber'];

const RESPONSE_STATUS = Object.freeze({
  1: 'approved',
  2: 'declined',
  3: 'error',
});

export class NmiError extends Error {
  /**
   * @param {string} code Machine-readable reason.
   * @param {string} message Human-readable reason. Never contains a secret.
   */
  constructor(code, message) {
    super(message);
    this.name = 'NmiError';
    this.code = code;
  }
}

function assertNoCardData(input) {
  for (const field of REFUSED_FIELDS) {
    if (input && Object.prototype.hasOwnProperty.call(input, field)) {
      throw new NmiError(
        'NMI_CARD_DATA_REFUSED',
        'Raw card data may not pass through this service. Use a Collect.js payment token.',
      );
    }
  }
}

function amountFromCents(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new NmiError('NMI_BAD_AMOUNT', 'amountCents must be a non-negative integer.');
  }
  return (amountCents / 100).toFixed(2);
}

/**
 * Strip everything sensitive from a parameter bag before it can reach a log.
 *
 * @param {Record<string, string>} params Request parameters.
 * @returns {Record<string, string>} A safe copy.
 */
export function redactParams(params) {
  const safe = {};
  for (const [key, value] of Object.entries(params)) {
    safe[key] = NEVER_LOG.has(key) ? '[redacted]' : value;
  }
  return safe;
}

/**
 * Normalise an NMI urlencoded response body.
 *
 * @param {string} body The raw response body.
 * @returns {{ status: 'approved'|'declined'|'error', ok: boolean, responseCode: string,
 *             responseText: string, transactionId: string|null, authCode: string|null,
 *             avsResponse: string|null, cvvResponse: string|null, orderId: string|null,
 *             responseCodeDetail: string|null, raw: Record<string, string> }} Result.
 */
export function parseNmiResponse(body) {
  const parsed = new URLSearchParams(typeof body === 'string' ? body : '');
  const raw = Object.fromEntries(parsed.entries());
  const responseCode = raw.response ?? '3';
  const status = RESPONSE_STATUS[responseCode] ?? 'error';
  return {
    status,
    ok: status === 'approved',
    responseCode,
    responseText: raw.responsetext ?? '',
    transactionId: raw.transactionid || null,
    authCode: raw.authcode || null,
    avsResponse: raw.avsresponse || null,
    cvvResponse: raw.cvvresponse || null,
    orderId: raw.orderid || null,
    responseCodeDetail: raw.response_code || null,
    customerVaultId: raw.customer_vault_id || null,
    raw,
  };
}

function mockResponse(params) {
  const amount = Number(params.amount ?? '0');
  const cents = Math.round(amount * 100);
  // Mirrors NMI's amount-triggered simulation so the staging test matrix has deterministic
  // declines and errors without a live gateway: x.05 declines, x.06 errors.
  const remainder = cents % 100;
  if (remainder === 5) {
    return parseNmiResponse(
      'response=2&responsetext=DECLINE&authcode=&transactionid=&avsresponse=N&cvvresponse=N&response_code=200',
    );
  }
  if (remainder === 6) {
    return parseNmiResponse(
      'response=3&responsetext=Gateway error simulated&authcode=&transactionid=&response_code=300',
    );
  }
  const transactionId = `MOCK${randomBytes(6).toString('hex').toUpperCase()}`;
  const search = new URLSearchParams({
    response: '1',
    responsetext: 'SUCCESS',
    authcode: randomBytes(3).toString('hex').toUpperCase(),
    transactionid: transactionId,
    avsresponse: 'Y',
    cvvresponse: 'M',
    response_code: '100',
    orderid: params.orderid ?? '',
    customer_vault_id: params.customer_vault === 'add_customer' ? `MOCKV${transactionId}` : '',
  });
  return parseNmiResponse(search.toString());
}

/**
 * Build a client bound to a gateway configuration.
 *
 * @param {{ apiUrl?: string, securityKey?: string, mock?: boolean, timeoutMs?: number,
 *           logger?: object, fetchImpl?: typeof fetch }} [options] Overrides; defaults come
 *        from `config.nmi`.
 * @returns {{ sale: Function, refund: Function, voidTransaction: Function, query: Function,
 *             validateVault: Function, request: Function, isMock: boolean }} The client.
 */
export function createNmiClient(options = {}) {
  const apiUrl = options.apiUrl ?? config.nmi.apiUrl;
  const securityKey = options.securityKey ?? config.nmi.securityKey;
  const timeoutMs = options.timeoutMs ?? config.nmi.timeoutMs;
  const logger = options.logger ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const isMock = options.mock ?? (securityKey === '' || securityKey === undefined);

  if (!isMock && typeof fetchImpl !== 'function') {
    throw new NmiError('NMI_NO_FETCH', 'A global fetch implementation is required.');
  }

  /**
   * Post a parameter bag to the gateway.
   *
   * @param {Record<string, string|number|undefined|null>} params Request parameters.
   * @returns {Promise<object>} The normalised response.
   */
  async function request(params) {
    assertNoCardData(params);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      body.set(key, String(value));
    }

    if (isMock) {
      const result = mockResponse(Object.fromEntries(body.entries()));
      if (logger) {
        logger.warn(
          { gateway: 'nmi', mock: true, type: body.get('type'), status: result.status },
          'NMI request served by the mock gateway; nothing was charged',
        );
      }
      return { ...result, mock: true };
    }

    body.set('security_key', securityKey);

    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/plain',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (logger) {
        logger.error(
          { gateway: 'nmi', type: body.get('type'), reason: error.name },
          'NMI request failed before a response was received',
        );
      }
      throw new NmiError('NMI_UNREACHABLE', 'The payment gateway did not respond.');
    }

    const text = await response.text();
    if (!response.ok) {
      if (logger) {
        logger.error(
          { gateway: 'nmi', status: response.status, type: body.get('type') },
          'NMI returned a non-2xx status',
        );
      }
      throw new NmiError('NMI_HTTP_ERROR', 'The payment gateway returned an unexpected status.');
    }

    const result = parseNmiResponse(text);
    if (logger) {
      logger.info(
        {
          gateway: 'nmi',
          type: body.get('type'),
          status: result.status,
          responseCode: result.responseCode,
          transactionId: result.transactionId,
        },
        'NMI response',
      );
    }
    return { ...result, mock: false };
  }

  return {
    isMock,

    request,

    /**
     * Charge a Collect.js payment token.
     *
     * @param {{ paymentToken: string, amountCents: number, orderId: string, email?: string,
     *           idempotencyKey?: string, currency?: string, orderDescription?: string,
     *           billingAddress?: object }} input Sale details.
     * @returns {Promise<object>} The normalised response.
     */
    async sale(input) {
      const {
        paymentToken,
        amountCents,
        orderId,
        email,
        idempotencyKey,
        currency = 'USD',
        orderDescription,
        billingAddress,
      } = input ?? {};
      if (typeof paymentToken !== 'string' || paymentToken === '') {
        throw new NmiError('NMI_NO_TOKEN', 'A Collect.js payment token is required.');
      }
      return request({
        type: 'sale',
        payment_token: paymentToken,
        amount: amountFromCents(amountCents),
        currency,
        orderid: orderId,
        order_description: orderDescription,
        email,
        // NMI duplicate detection keys off this value in addition to our own idempotency
        // record, so a retried submission cannot double-charge.
        merchant_defined_field_1: idempotencyKey,
        first_name: billingAddress?.firstName,
        last_name: billingAddress?.lastName,
        address1: billingAddress?.line1,
        city: billingAddress?.city,
        state: billingAddress?.region,
        zip: billingAddress?.postalCode,
        country: billingAddress?.country,
      });
    },

    /**
     * Refund a settled transaction, fully or partially.
     *
     * @param {{ transactionId: string, amountCents?: number|null }} input Refund details.
     * @returns {Promise<object>} The normalised response.
     */
    async refund({ transactionId, amountCents = null } = {}) {
      if (typeof transactionId !== 'string' || transactionId === '') {
        throw new NmiError('NMI_NO_TRANSACTION', 'A transaction id is required.');
      }
      return request({
        type: 'refund',
        transactionid: transactionId,
        amount: amountCents === null ? undefined : amountFromCents(amountCents),
      });
    },

    /**
     * Void an authorisation that has not yet settled.
     *
     * @param {{ transactionId: string }} input Void details.
     * @returns {Promise<object>} The normalised response.
     */
    async voidTransaction({ transactionId } = {}) {
      if (typeof transactionId !== 'string' || transactionId === '') {
        throw new NmiError('NMI_NO_TRANSACTION', 'A transaction id is required.');
      }
      return request({ type: 'void', transactionid: transactionId });
    },

    /**
     * Query a transaction. Used before accepting a retry when the original outcome is
     * ambiguous, and to re-verify amounts reported by a webhook (§9.6).
     *
     * @param {{ transactionId: string }} input Query details.
     * @returns {Promise<object>} The normalised response.
     */
    async query({ transactionId } = {}) {
      if (typeof transactionId !== 'string' || transactionId === '') {
        throw new NmiError('NMI_NO_TRANSACTION', 'A transaction id is required.');
      }
      return request({ type: 'query', transaction_id: transactionId });
    },

    /**
     * Validate a payment token and add it to the Customer Vault, without charging.
     * Phase 1 uses this only for hardcover reservations, behind the purchase flag —
     * vaulting a card with nothing to charge is unjustified retention (§6.5.3).
     *
     * @param {{ paymentToken: string, email?: string, orderId?: string,
     *           billingAddress?: object }} input Vault details.
     * @returns {Promise<object>} The normalised response.
     */
    async validateVault({ paymentToken, email, orderId, billingAddress } = {}) {
      if (typeof paymentToken !== 'string' || paymentToken === '') {
        throw new NmiError('NMI_NO_TOKEN', 'A Collect.js payment token is required.');
      }
      return request({
        type: 'validate',
        customer_vault: 'add_customer',
        payment_token: paymentToken,
        orderid: orderId,
        email,
        first_name: billingAddress?.firstName,
        last_name: billingAddress?.lastName,
        address1: billingAddress?.line1,
        city: billingAddress?.city,
        state: billingAddress?.region,
        zip: billingAddress?.postalCode,
        country: billingAddress?.country,
      });
    },
  };
}

let defaultClient = null;

/**
 * The process-wide client, built from `config.nmi` on first use.
 *
 * @param {object} [logger] Optional logger to bind on first construction.
 * @returns {ReturnType<typeof createNmiClient>} The shared client.
 */
export function nmiClient(logger) {
  if (defaultClient === null) defaultClient = createNmiClient({ logger });
  return defaultClient;
}

/** @see createNmiClient */
export function sale(input) {
  return nmiClient().sale(input);
}

/** @see createNmiClient */
export function refund(input) {
  return nmiClient().refund(input);
}

/** @see createNmiClient */
export function voidTransaction(input) {
  return nmiClient().voidTransaction(input);
}

/** @see createNmiClient */
export function query(input) {
  return nmiClient().query(input);
}

/** @see createNmiClient */
export function validateVault(input) {
  return nmiClient().validateVault(input);
}
