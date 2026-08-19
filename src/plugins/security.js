/**
 * Security headers.
 *
 * This service returns JSON and nothing else: no HTML, no scripts, no styles, no images,
 * no frames. The Content-Security-Policy therefore denies everything by default —
 * `default-src 'none'` — which makes the policy meaningful rather than decorative. If a
 * response is ever coerced into being rendered as a document, nothing in it can execute.
 *
 * HSTS is production-only: sending it from a local http listener would poison the
 * developer's browser for `localhost`.
 *
 * No server banner, no `x-powered-by`: version disclosure hands an attacker the CVE list.
 */

import helmet from '@fastify/helmet';

/** Denies every resource class. A JSON API needs none of them. */
const CONTENT_SECURITY_POLICY = Object.freeze({
  useDefaults: false,
  directives: {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'script-src': ["'none'"],
    'style-src': ["'none'"],
    'img-src': ["'none'"],
    'connect-src': ["'none'"],
    'font-src': ["'none'"],
    'media-src': ["'none'"],
    'worker-src': ["'none'"],
    'manifest-src': ["'none'"],
  },
});

const HSTS = Object.freeze({
  maxAge: 31_536_000,
  includeSubDomains: true,
  preload: true,
});

/**
 * @param {import('fastify').FastifyInstance} fastify The instance.
 * @param {{ config: object }} options Plugin options.
 * @returns {Promise<void>} Resolves when registered.
 */
async function securityPlugin(fastify, options) {
  const { config } = options;

  await fastify.register(helmet, {
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // The reading experience is served from a different origin than this API, so the
    // resource policy must permit it. CORS (see plugins/cors.js) is the actual gate.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: config.isProduction ? HSTS : false,
    ieNoOpen: true,
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    // The privacy posture forbids collecting referrers; do not send them either.
    referrerPolicy: { policy: 'no-referrer' },
    xssFilter: false,
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    // Node does not send a Server header by default, but a proxy or a future middleware
    // might; strip it unconditionally rather than assume.
    reply.removeHeader('server');
    reply.removeHeader('x-powered-by');
    // Nothing this API returns is a cacheable, shareable representation by default. The
    // manuscript unit route overrides this deliberately with its immutable cache policy.
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}

securityPlugin[Symbol.for('skip-override')] = true;
securityPlugin[Symbol.for('fastify.display-name')] = 'ogp-security';

export default securityPlugin;
