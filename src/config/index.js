import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

const VALID_ENVIRONMENTS = ['development', 'test', 'staging', 'production'];
const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const VALID_EMAIL_TRANSPORTS = ['log', 'smtp'];

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_MARKERS = ['change-me', 'changeme', 'replace-me', 'your-secret'];

const SESSION_TTL_DAYS = 400;

const BODY_LIMIT_BYTES = 128 * 1024;

const SHUTDOWN_TIMEOUT_MS = 10_000;

const WEBHOOK_TOLERANCE_SECONDS = 300;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function readString(env, key, fallback = '') {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

function readBoolean(env, key, fallback, problems) {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  const lowered = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  problems.push(`${key} must be a boolean ("true" or "false"), received "${raw}".`);
  return fallback;
}

function readInteger(env, key, fallback, { min, max }, problems) {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    problems.push(`${key} must be an integer, received "${raw}".`);
    return fallback;
  }
  if (typeof min === 'number' && parsed < min) {
    problems.push(`${key} must be >= ${min}, received ${parsed}.`);
    return fallback;
  }
  if (typeof max === 'number' && parsed > max) {
    problems.push(`${key} must be <= ${max}, received ${parsed}.`);
    return fallback;
  }
  return parsed;
}

function readEnum(env, key, allowed, fallback, problems) {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  if (!allowed.includes(raw)) {
    problems.push(`${key} must be one of ${allowed.join(', ')}; received "${raw}".`);
    return fallback;
  }
  return raw;
}

function readOriginList(env, key, problems, fallback = '') {
  const raw = readString(env, key, fallback);
  if (raw === '') return [];
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      problems.push(`${key} contains "${origin}", which is not an absolute origin.`);
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      problems.push(`${key} entry "${origin}" must use http or https.`);
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      problems.push(`${key} entry "${origin}" must be an origin only — no path, query or hash.`);
    }
  }
  return origins.map((origin) => new URL(origin).origin);
}

function looksLikePlaceholder(value) {
  const lowered = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
}

function requireSecret(value, key, { isProduction, problems, warnings }) {
  if (value === '') {
    if (isProduction) problems.push(`${key} is required in production.`);
    else warnings.push(`${key} is empty; a development-only value is in use.`);
    return value;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    const message = `${key} must be at least ${MIN_SECRET_LENGTH} characters.`;
    if (isProduction) problems.push(message);
    else warnings.push(message);
  }
  if (looksLikePlaceholder(value)) {
    const message = `${key} still holds a placeholder value from .env.example.`;
    if (isProduction) problems.push(message);
    else warnings.push(message);
  }
  return value;
}

function requirePresent(value, key, { isProduction, problems }) {
  if (value === '' && isProduction) problems.push(`${key} is required in production.`);
  return value;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const warnings = [];

  const nodeEnv = readEnum(env, 'NODE_ENV', VALID_ENVIRONMENTS, 'development', problems);
  const isProduction = nodeEnv === 'production';
  const isDevelopment = nodeEnv === 'development';
  const isTest = nodeEnv === 'test';
  const isStaging = nodeEnv === 'staging';

  const host = readString(env, 'HOST', '0.0.0.0');
  const port = readInteger(env, 'PORT', 8080, { min: 1, max: 65535 }, problems);
  const logLevel = readEnum(env, 'LOG_LEVEL', VALID_LOG_LEVELS, isTest ? 'silent' : 'info', problems);

  const mongoUri = requirePresent(
    readString(env, 'MONGODB_URI', isProduction ? '' : 'mongodb://127.0.0.1:27017'),
    'MONGODB_URI',
    { isProduction, problems },
  );
  const mongoDb = requirePresent(
    readString(env, 'MONGODB_DB', isProduction ? '' : 'ogp'),
    'MONGODB_DB',
    { isProduction, problems },
  );
  const mongoIsLocal = /^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])\b/i.test(mongoUri);

  const sessionTokenSecret = requireSecret(
    readString(env, 'SESSION_TOKEN_SECRET', isProduction ? '' : 'ogp-development-session-secret-000'),
    'SESSION_TOKEN_SECRET',
    { isProduction, problems, warnings },
  );
  const sessionTokenSecretPrevious = readString(env, 'SESSION_TOKEN_SECRET_PREVIOUS', '');
  const adminJwtSecret = requireSecret(
    readString(env, 'ADMIN_JWT_SECRET', isProduction ? '' : 'ogp-development-admin-jwt-secret-00'),
    'ADMIN_JWT_SECRET',
    { isProduction, problems, warnings },
  );
  const receiptSigningSecret = requireSecret(
    readString(env, 'RECEIPT_SIGNING_SECRET', isProduction ? '' : 'ogp-development-receipt-secret-000'),
    'RECEIPT_SIGNING_SECRET',
    { isProduction, problems, warnings },
  );

  if (sessionTokenSecretPrevious !== '' && sessionTokenSecretPrevious === sessionTokenSecret) {
    problems.push('SESSION_TOKEN_SECRET_PREVIOUS must differ from SESSION_TOKEN_SECRET.');
  }

  const publicOrigin = requirePresent(
    readString(env, 'PUBLIC_ORIGIN', isProduction ? '' : 'http://localhost:5173'),
    'PUBLIC_ORIGIN',
    { isProduction, problems },
  );
  if (publicOrigin !== '') {
    try {
      const parsed = new URL(publicOrigin);
      if (isProduction && parsed.protocol !== 'https:') {
        problems.push('PUBLIC_ORIGIN must use https in production.');
      }
    } catch {
      problems.push(`PUBLIC_ORIGIN is not a valid absolute URL: "${publicOrigin}".`);
    }
  }

  const corsOrigins = readOriginList(
    env,
    'CORS_ORIGINS',
    problems,
    isProduction ? '' : 'http://localhost:5173',
  );
  if (corsOrigins.length === 0 && isProduction) {
    problems.push('CORS_ORIGINS is required in production; an empty list denies every browser client.');
  }

  const cdnBaseUrl = readString(env, 'CDN_BASE_URL', '');
  if (cdnBaseUrl !== '') {
    try {
      new URL(cdnBaseUrl);
    } catch {
      problems.push(`CDN_BASE_URL is not a valid absolute URL: "${cdnBaseUrl}".`);
    }
  }

  const nmiSecurityKey = readString(env, 'NMI_SECURITY_KEY', '');
  const nmiCollectJsKey = readString(env, 'NMI_COLLECT_JS_KEY', '');
  const nmiWebhookSigningKey = readString(env, 'NMI_WEBHOOK_SIGNING_KEY', '');
  const nmiApiUrl = readString(env, 'NMI_API_URL', 'https://secure.nmi.com/api/transact.php');
  try {
    new URL(nmiApiUrl);
  } catch {
    problems.push(`NMI_API_URL is not a valid absolute URL: "${nmiApiUrl}".`);
  }
  const nmiMock = nmiSecurityKey === '';
  if (nmiMock) {
    const message =
      'NMI_SECURITY_KEY is not set — the payment gateway client runs in mock mode and settles nothing.';
    if (isProduction) problems.push('NMI_SECURITY_KEY is required in production.');
    else warnings.push(message);
  }
  if (!nmiMock && nmiWebhookSigningKey === '') {
    const message = 'NMI_WEBHOOK_SIGNING_KEY is required whenever NMI_SECURITY_KEY is configured.';
    if (isProduction) problems.push(message);
    else warnings.push(message);
  }

  const emailTransport = readEnum(
    env,
    'EMAIL_TRANSPORT',
    VALID_EMAIL_TRANSPORTS,
    'log',
    problems,
  );
  const emailFrom = requirePresent(
    readString(env, 'EMAIL_FROM', isProduction ? '' : 'foundingbetareaders@oneglobalpeople.org'),
    'EMAIL_FROM',
    { isProduction, problems },
  );
  const smtpHost = readString(env, 'SMTP_HOST', '');
  const smtpPort = readInteger(env, 'SMTP_PORT', 465, { min: 1, max: 65_535 }, problems);
  const smtpUser = readString(env, 'SMTP_USER', '');
  const smtpPass = readString(env, 'SMTP_PASS', '');
  if (emailTransport === 'smtp' && smtpHost === '') {
    problems.push('SMTP_HOST is required when EMAIL_TRANSPORT is "smtp".');
  }
  if (emailTransport === 'log' && isProduction) {
    warnings.push('EMAIL_TRANSPORT is "log" in production — no message will reach a recipient.');
  }
  const smtpFrom = readString(env, 'SMTP_FROM', '');

  const invitePath = readString(env, 'INVITE_PATH', '/');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(invitePath)) {
    problems.push(
      `INVITE_PATH must be an absolute path with no query or fragment; received "${invitePath}".`,
    );
  }

  const flags = {
    ageLayerEnabled: readBoolean(env, 'AGE_LAYER_ENABLED', false, problems),
    freeAccessEnabled: readBoolean(env, 'FREE_ACCESS_ENABLED', false, problems),
    hardcoverPurchasable: readBoolean(env, 'HARDCOVER_PURCHASABLE', false, problems),
    sharingEnabled: readBoolean(env, 'SHARING_ENABLED', true, problems),
  };

  const adminDevLogin = {
    enabled: !isProduction && readBoolean(env, 'ADMIN_DEV_LOGIN', true, problems),
    name: readString(env, 'ADMIN_DEV_NAME', 'admin').trim().toLowerCase(),
    password: readString(env, 'ADMIN_DEV_PASSWORD', 'OGP2468#'),
  };
  if (adminDevLogin.enabled) {
    warnings.push(
      'ADMIN_DEV_LOGIN is on: the operations panel accepts a fixed name and password with no ' +
        'second factor. Development only — set it to false before any shared deployment.',
    );
  }

  const rateLimitRedisUrl = readString(env, 'RATE_LIMIT_REDIS_URL', '');
  if (rateLimitRedisUrl !== '') {
    warnings.push(
      'RATE_LIMIT_REDIS_URL is set, but no Redis client is a declared dependency; ' +
        'the in-memory rate-limit store remains in use (single-node semantics).',
    );
  }
  const eventFlushIntervalMs = readInteger(
    env,
    'EVENT_FLUSH_INTERVAL_MS',
    2000,
    { min: 100, max: 60_000 },
    problems,
  );
  const eventFlushMaxBatch = readInteger(
    env,
    'EVENT_FLUSH_MAX_BATCH',
    500,
    { min: 1, max: 10_000 },
    problems,
  );

  if (problems.length > 0) {
    throw new Error(
      `Invalid backend configuration (NODE_ENV=${nodeEnv}):\n  - ${problems.join('\n  - ')}`,
    );
  }

  return deepFreeze({
    env: nodeEnv,
    isProduction,
    isDevelopment,
    isTest,
    isStaging,

    host,
    port,
    logLevel,

    autoIndex: !isProduction,
    applyValidators: !isProduction,

    bodyLimitBytes: BODY_LIMIT_BYTES,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,

    mongo: {
      uri: mongoUri,
      db: mongoDb,
      maxPoolSize: 20,
      serverSelectionTimeoutMS: mongoIsLocal ? 8000 : 20000,
      pluginTimeoutMs: mongoIsLocal ? 10_000 : 0,
    },

    secrets: {
      sessionToken: sessionTokenSecret,
      sessionTokenPrevious: sessionTokenSecretPrevious,
      adminJwt: adminJwtSecret,
      receiptSigning: receiptSigningSecret,
    },

    origins: {
      publicOrigin,
      corsOrigins,
      cdnBaseUrl,
    },

    nmi: {
      apiUrl: nmiApiUrl,
      securityKey: nmiSecurityKey,
      collectJsKey: nmiCollectJsKey,
      webhookSigningKey: nmiWebhookSigningKey,
      mock: nmiMock,
      timeoutMs: 20_000,
      webhookToleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
    },

    mail: {
      transport: emailTransport,
      from: emailFrom,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      smtpFrom: smtpFrom === '' ? emailFrom : smtpFrom,
      invitePath,
    },

    flags,
    adminDevLogin,

    session: {
      ttlDays: SESSION_TTL_DAYS,
    },

    events: {
      batchLimit: 20,
      flushIntervalMs: eventFlushIntervalMs,
      flushMaxBatch: eventFlushMaxBatch,
    },

    rateLimit: {
      redisUrl: rateLimitRedisUrl,
    },

    warnings,
  });
}

dotenv.config({ path: ENV_FILE, quiet: true });

export const config = loadConfig();

export default config;
