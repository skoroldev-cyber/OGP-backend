const CORRELATION_HEADER = 'x-correlation-id';

export class ApiError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
    if (options.quietResponse !== undefined) this.quietResponse = options.quietResponse;
    if (options.quietStatusCode !== undefined) this.quietStatusCode = options.quietStatusCode;
  }
}

export function apiError(statusCode, code, message) {
  return new ApiError(statusCode, code, message);
}

const STATUS_DEFAULTS = Object.freeze({
  400: { code: 'BAD_REQUEST', message: 'The request could not be understood.' },
  401: { code: 'UNAUTHORIZED', message: 'Authentication is required for this request.' },
  403: { code: 'FORBIDDEN', message: 'This request is not permitted.' },
  404: { code: 'NOT_FOUND', message: 'That resource does not exist.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'That method is not available here.' },
  406: { code: 'NOT_ACCEPTABLE', message: 'The requested representation is not available.' },
  409: { code: 'CONFLICT', message: 'That request conflicts with the current state.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is larger than allowed.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'That content type is not accepted.' },
  422: { code: 'UNPROCESSABLE', message: 'The request could not be processed.' },
  423: { code: 'LOCKED', message: 'That content is locked and cannot be modified.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
  500: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' },
});

const FALLBACK = STATUS_DEFAULTS[500];

function describeValidation(validation, context) {
  if (!Array.isArray(validation) || validation.length === 0) {
    return 'The request did not match the expected shape.';
  }
  const first = validation[0];
  const path = String(first.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
  const where = context ? `${context}${path ? `.${path}` : ''}` : path || 'request';
  switch (first.keyword) {
    case 'required':
      return `${where}: "${first.params?.missingProperty}" is required.`;
    case 'additionalProperties':
      return `${where}: "${first.params?.additionalProperty}" is not an accepted field.`;
    case 'enum':
      return `${where}: value is not one of the accepted options.`;
    case 'type':
      return `${where}: expected ${first.params?.type}.`;
    default:
      return `${where}: ${first.message ?? 'is invalid'}.`;
  }
}

export function toEnvelope(error) {
  if (error && Array.isArray(error.validation)) {
    return {
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: describeValidation(error.validation, error.validationContext),
    };
  }

  if (error && (error.code === 11000 || error.code === 11001)) {
    return { statusCode: 409, ...STATUS_DEFAULTS[409], code: 'CONFLICT' };
  }

  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;

  const declaredCode = typeof error?.code === 'string' ? error.code : null;
  const isPublicCode = declaredCode !== null && /^[A-Z][A-Z0-9_]{2,63}$/.test(declaredCode);
  const isFastifyInternal = declaredCode !== null && declaredCode.startsWith('FST_');

  if (statusCode >= 500) {
    return { statusCode, ...(STATUS_DEFAULTS[statusCode] ?? FALLBACK) };
  }

  const fallback = STATUS_DEFAULTS[statusCode] ?? STATUS_DEFAULTS[400];
  if (isPublicCode && !isFastifyInternal && error.expose === true) {
    return {
      statusCode,
      code: declaredCode,
      message: typeof error.message === 'string' && error.message ? error.message : fallback.message,
    };
  }
  if (isPublicCode && !isFastifyInternal) {
    return { statusCode, code: declaredCode, message: fallback.message };
  }
  return { statusCode, ...fallback };
}

async function errorsPlugin(fastify) {
  fastify.decorate('ApiError', ApiError);

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header(CORRELATION_HEADER, request.id);
    return payload;
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { ...STATUS_DEFAULTS[404] } });
  });

  fastify.setErrorHandler((error, request, reply) => {
    const envelope = toEnvelope(error);

    const logPayload = {
      err: error,
      correlationId: request.id,
      route: request.routeOptions?.url ?? null,
      statusCode: envelope.statusCode,
      errorCode: envelope.code,
    };
    if (envelope.statusCode >= 500) request.log.error(logPayload, 'request failed');
    else if (envelope.statusCode === 429) request.log.warn(logPayload, 'request rate limited');
    else request.log.info(logPayload, 'request rejected');

    if (error && error.quietResponse !== undefined && error.quietResponse !== null) {
      reply.code(error.quietStatusCode ?? 200).send(error.quietResponse);
      return;
    }

    reply
      .code(envelope.statusCode)
      .send({ error: { code: envelope.code, message: envelope.message } });
  });
}

errorsPlugin[Symbol.for('skip-override')] = true;
errorsPlugin[Symbol.for('fastify.display-name')] = 'ogp-errors';

export default errorsPlugin;
