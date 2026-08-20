import helmet from '@fastify/helmet';

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

async function securityPlugin(fastify, options) {
  const { config } = options;

  await fastify.register(helmet, {
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: config.isProduction ? HSTS : false,
    ieNoOpen: true,
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    referrerPolicy: { policy: 'no-referrer' },
    xssFilter: false,
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.removeHeader('server');
    reply.removeHeader('x-powered-by');
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}

securityPlugin[Symbol.for('skip-override')] = true;
securityPlugin[Symbol.for('fastify.display-name')] = 'ogp-security';

export default securityPlugin;
