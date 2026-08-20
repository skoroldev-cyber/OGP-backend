import { randomBytes } from 'node:crypto';
import config from '../config/index.js';

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

const REFUSED_FIELDS = ['ccnumber', 'ccexp', 'cvv', 'card_number', 'cardNumber'];

const RESPONSE_STATUS = Object.freeze({
  1: 'approved',
  2: 'declined',
  3: 'error',
});

export class NmiError extends Error {
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

export function redactParams(params) {
  const safe = {};
  for (const [key, value] of Object.entries(params)) {
    safe[key] = NEVER_LOG.has(key) ? '[redacted]' : value;
  }
  return safe;
}

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

    async voidTransaction({ transactionId } = {}) {
      if (typeof transactionId !== 'string' || transactionId === '') {
        throw new NmiError('NMI_NO_TRANSACTION', 'A transaction id is required.');
      }
      return request({ type: 'void', transactionid: transactionId });
    },

    async query({ transactionId } = {}) {
      if (typeof transactionId !== 'string' || transactionId === '') {
        throw new NmiError('NMI_NO_TRANSACTION', 'A transaction id is required.');
      }
      return request({ type: 'query', transaction_id: transactionId });
    },

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

export function nmiClient(logger) {
  if (defaultClient === null) defaultClient = createNmiClient({ logger });
  return defaultClient;
}

export function sale(input) {
  return nmiClient().sale(input);
}

export function refund(input) {
  return nmiClient().refund(input);
}

export function voidTransaction(input) {
  return nmiClient().voidTransaction(input);
}

export function query(input) {
  return nmiClient().query(input);
}

export function validateVault(input) {
  return nmiClient().validateVault(input);
}
