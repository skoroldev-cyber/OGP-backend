# One Global People — API

The backend for the One Global People reading platform: anonymous reading sessions,
canonical manuscript delivery, first-party event ingestion, regulated sharing, the Founding
Reader beta programme, and NMI commerce.

Fastify 5 on Node.js 22+ (ESM), MongoDB 6 driver. The dependency set is deliberately small:
`fastify`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `mongodb`, `dotenv`,
and `node:` builtins. Password hashing (scrypt), JWT (HS256), TOTP (RFC 6238), ULIDs and
webhook signature verification are implemented against `node:crypto` rather than pulled in.

---

## What this service is for

The experience is **one continuous application with state transitions**, not a set of pages.
The API serves one continuous session, and four constraints govern every decision in it:

1. **No account is required to read.** There is no signup wall between a reader and the
   manuscript. A session is 256 bits of randomness; the server stores only its SHA-256 hash.
2. **Age range is session state only.** It selects a rendering. It is never profiled, never
   aggregated to an individual, never joined to anything.
3. **Sharing is gated server-side.** "Sharing is human continuity transfer only after
   recognition, reflection, decompression, and regulation." A client cannot talk the server
   into opening a share window.
4. **Everything scales horizontally without a rebuild.** Stateless API nodes; the two
   stateful concessions (in-memory rate limiter, in-process event buffer) have declared
   Redis and queue upgrade paths that do not change the `POST /events` contract.

---

## Running it

```bash
npm ci
cp .env.example .env          # then fill in the secrets
npm run dev                   # node --watch src/server.js
```

MongoDB must be reachable at `MONGODB_URI`. In development the service applies the
`$jsonSchema` validators and every index on boot; in production it does neither — run them
as an explicit deployment step:

```bash
npm run db:indexes
```

Other scripts:

| Script | Purpose |
|---|---|
| `npm start` | Production entry (`node src/server.js`) |
| `npm run lint` | ESLint over the whole service |
| `npm test` | `node --test test/` |
| `npm run check:prohibited-data` | The anti-profiling schema assertion, on its own |
| `npm run ingest:manuscript` | Segment and load the Public Founding Edition |
| `npm run db:seed` | Seed products, prompts, questionnaires |
| `npm run admin:create` | Create an admin account (password + TOTP enrolment) |
| `npm run verify` | `lint` then `test` |

Logs are line-delimited JSON. For a readable development stream, pipe them:
`npm run dev | npx pino-pretty`.

---

## Environment contract

Every variable is documented in `.env.example`; the loader (`src/config/index.js`) reads
nothing else. In `production` a missing or placeholder value is a **boot failure**, not a
warning — a service that starts with a default signing secret is worse than one that does
not start.

| Variable | Required in production | Notes |
|---|---|---|
| `NODE_ENV` | — | `development` \| `test` \| `staging` \| `production`. Staging is a first-class environment. |
| `HOST`, `PORT` | — | Defaults `0.0.0.0:8080`. |
| `LOG_LEVEL` | — | pino level; `silent` disables logging entirely. |
| `MONGODB_URI`, `MONGODB_DB` | ✔ | The API's database user holds `readWrite` on the app database only. |
| `SESSION_TOKEN_SECRET` | ✔ | HMAC key for signed session-scoped artifacts and rate-limit keying. ≥ 32 chars. |
| `SESSION_TOKEN_SECRET_PREVIOUS` | — | The retiring key during a rotation window. Verification accepts both. |
| `ADMIN_JWT_SECRET` | ✔ | HS256 key for admin access tokens. ≥ 32 chars. |
| `ADMIN_DEV_LOGIN`, `ADMIN_DEV_NAME`, `ADMIN_DEV_PASSWORD` | — | Interim operations sign-in. Off in production regardless of the flag. Must match the frontend `VITE_ADMIN_LOCAL_GATE_*` values. |
| `RECEIPT_SIGNING_SECRET` | ✔ | Signs receipt links and transcript access grants. ≥ 32 chars. |
| `PUBLIC_ORIGIN` | ✔ | Must be `https` in production. Used to build share and receipt URLs. |
| `CORS_ORIGINS` | ✔ | Comma-separated absolute origins. Empty denies every browser client. |
| `CDN_BASE_URL` | — | Publish-time snapshot target for manuscript units. |
| `NMI_SECURITY_KEY` | ✔ | Private Payment API key. **Empty ⇒ the gateway client runs in mock mode.** |
| `NMI_COLLECT_JS_KEY` | — | Public tokenisation key. Mirrored to the frontend; not a secret. |
| `NMI_WEBHOOK_SIGNING_KEY` | ✔ when a security key is set | HMAC key for webhook verification. |
| `NMI_API_URL` | — | Defaults to `https://secure.nmi.com/api/transact.php`. |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `EMAIL_FROM` ✔ | `log` writes a structured record and delivers nothing. `smtp` requires `SMTP_HOST`. |
| `AGE_LAYER_ENABLED` | — | Default `false`. Only `full_manuscript` is certified today. |
| `FREE_ACCESS_ENABLED` | — | Default `false`. Founder switch for the free transcript path. |
| `HARDCOVER_PURCHASABLE` | — | Default `false`. Requires `products.priceCents`, which the founder must set. |
| `SHARING_ENABLED` | — | Default `true`. The server still gates every individual prompt. |
| `RATE_LIMIT_REDIS_URL` | — | Declared for the multi-node path. No Redis client is installed yet; the in-memory store stays in use and the loader warns. |
| `EVENT_FLUSH_INTERVAL_MS`, `EVENT_FLUSH_MAX_BATCH` | — | Event buffer flush cadence (defaults 2000 ms / 500 events). |

**No secret ever appears in a `VITE_` variable or in the repository.**

---

## Layout

```
src/
├── server.js              entry: boot, listen, graceful shutdown
├── app.js                 buildApp({ config, logger }) → configured Fastify instance
├── config/
│   ├── index.js           typed env loading, fail-fast, frozen config
│   └── constants.js       canonical vocabularies (states, events, layers, roles, …)
├── plugins/
│   ├── errors.js          { error: { code, message } } envelope + correlation id
│   ├── security.js        helmet, deny-all CSP, HSTS in production
│   ├── cors.js            allow-list from CORS_ORIGINS only
│   ├── rateLimit.js       named per-route budgets (§9.6)
│   ├── mongo.js           connection, collections, indexes, validators, readiness
│   ├── sessionAuth.js     requireSession / optionalSession
│   └── adminAuth.js       requireAdmin(roles[])
├── db/
│   ├── collections.js     the collection names and typed accessors
│   ├── indexes.js         every index, plus drift detection
│   └── validators.js      $jsonSchema per collection — the anti-profiling rules, executable
├── lib/
│   ├── ids.js             monotonic ULIDs, opaque 21-char tokens, prefixed ids
│   ├── tokens.js          session token mint/hash, HMAC-signed receipt & grant tokens
│   ├── hash.js            scrypt password hashing
│   ├── jwt.js             HS256 sign/verify
│   ├── totp.js            RFC 6238 verify, base32 secrets, otpauth:// URIs
│   ├── audit.js           append-only audit_log writer with redaction
│   ├── rulesLint.js       prohibited-terms lint over content/rules.json
│   ├── nmiClient.js       NMI Payment API client (+ mock mode)
│   ├── webhookVerify.js   constant-time HMAC verification over the raw body
│   ├── mailer.js          transport abstraction and linted templates
│   └── schemas.js         shared JSON-Schema fragments
└── modules/               route adapters + services, one directory per domain
```

### Module map

All under `/api/v1`. Auth codes: **P** public · **S** session bearer · **A** admin JWT ·
**W** webhook signature.

| Module | Surface |
|---|---|
| `sessions` | `POST /sessions` (P) · `GET|PATCH|DELETE /sessions/current` (S) · `POST /sessions/current/progress` (S) |
| `manuscript` | `GET /manuscript/manifest` (S) · `GET /manuscript/units/:unitId` (S) |
| `events` | `POST /events` (S) — batch ≤ 20, `202 { accepted }`, fire-and-forget |
| `sharing` | `GET /sharing/eligibility` (S) · `POST /shares` (S) · `POST /shares/:token/revoke` (S) · `GET /shares/:token` (P) |
| `invitations` | `POST /invitations/redeem` (S) |
| `feedback` | `GET /questionnaires/active` (S) · `POST /questionnaire-responses` (S) · `POST /feedback` (S) · `GET /feedback/mine` (S) |
| `family` | `POST /family` (S, gate-checked) · `POST /family/withdraw` (P) |
| `commerce` | products, donations, free access, orders, reservations, receipts, transcript grants, `POST /webhooks/nmi` (W) |
| `admin` | `/admin/**` (A) — auth, content, resonance, sharing prompts, beta, feedback, commerce, metrics, ops |

Plus `GET /healthz` at the root: liveness only, no version disclosure.

**Architectural rules the modules must honour:**

- Services never import Fastify. Routes are thin adapters over services.
- Every route schema sets `additionalProperties: false`, and Ajv is configured with
  `removeAdditional: false`, so an undeclared field is a `400 VALIDATION_FAILED` rather than
  a silent drop.
- No cross-document transactions on hot paths.
- The event write path is fire-and-forget: a failure there never surfaces to the reader.
- `request.rawBody` is preserved for every JSON request so webhook signatures verify against
  the exact bytes.

### Extension points the core provides

| Decorator | Provided by | Use |
|---|---|---|
| `fastify.config` | `app.js` | The frozen configuration object |
| `fastify.db`, `fastify.mongo`, `fastify.collections` | `plugins/mongo.js` | Database access |
| `fastify.mongoReady()` | `plugins/mongo.js` | Bounded readiness probe for `/admin/health/detail` |
| `fastify.requireSession`, `fastify.optionalSession`, `fastify.resolveSession` | `plugins/sessionAuth.js` | `preHandler` for **S** routes |
| `fastify.requireAdmin(roles)` | `plugins/adminAuth.js` | `preHandler` factory for **A** routes |
| `fastify.rateLimits.*` | `plugins/rateLimit.js` | Named budgets to attach as `config.rateLimit` |
| `fastify.ApiError` | `plugins/errors.js` | Throwable error carrying a vetted code and message |

The events module is expected to decorate `app.flushEvents()`; `server.js` awaits it during
shutdown so a redeploy never discards buffered events.

---

## Privacy posture

Data minimisation is a product feature. The platform tells readers "It is not used to
profile you," and the claim is enforced by the schema, not by discipline.

- **No birthdate, no gender, no IP, no user-agent, no geolocation, no referrer URL** exists
  anywhere in the data model. `src/config/constants.js` names the prohibited fields;
  `src/db/validators.js` declares a **closed** property set for every collection, so those
  fields are structurally unwritable. `npm run check:prohibited-data` asserts it.
- **IPs are used transiently** as rate-limit keys and are never written to a document or a
  log line. Session rate-limit keys are an HMAC of the bearer token, so the limiter's store
  cannot be turned back into a session.
- **Logs carry no PII**: the access log records the route *pattern*, status and duration —
  not the raw URL (which can contain a share or receipt token) and not the address.
- **Age band lives on `reading_sessions` and nowhere else.** Changing it overwrites it; no
  age history is kept. Analytics see `contentLayer` aggregates only.
- **Severability**: `sessionId` on donations, orders, family records and questionnaire
  responses exists only to complete a funnel. `DELETE /sessions/current` nulls it.
- **No third-party analytics, pixels or trackers.** No Google Analytics, no PostHog. Product
  analytics are computed in the admin dashboard from the first-party `events` collection.
- **Share counters are private.** `share_tokens.openCount` is an operational number.
  Rendering it in any reader-facing surface would be a prohibited mechanic.

### Copy law

`content/rules.json` is the machine-readable source of truth for the seventeen prohibited
terms. `src/lib/rulesLint.js` enforces it: admin-authored sharing prompt copy and every mail
template are linted before they can be stored or sent. The `"Become Family."` pathway is held
to an additional rule — no reader-facing string on it may contain "member" in any form.

---

## Security notes

- **Card data never touches this service.** The browser tokenises through NMI Collect.js
  hosted fields; the server receives a one-time `payment_token`. `lib/nmiClient.js` *refuses*
  a request containing a card number, expiry or CVV rather than forwarding it. Only brand and
  last four digits are ever stored. SAQ-A scope.
- **Webhooks** are HMAC-SHA256 verified over `<timestamp>.<raw body>` with a 5-minute skew
  window, processed idempotently by gateway event id, and never trusted for amounts — the
  amount is re-queried through the Payment API.
- **Admin auth** is a 15-minute HS256 access token plus a rotating refresh token bound to a
  server-side record. TOTP MFA is mandatory: `plugins/adminAuth.js` refuses a token whose
  account has no confirmed enrolment. Content publishing requires editor and reviewer as two
  distinct users; canonical-lock overrides require `founder`.
- **Secret rotation**: `SESSION_TOKEN_SECRET_PREVIOUS` keeps signed links valid across a
  rotation window. Reader session tokens are unaffected by rotation by design — their hash
  carries no secret, so rotating a key never evicts a reader from the manuscript.
- **The plaintext-credential remediation is a launch gate.** Every credential that ever
  appeared in project chat must be rotated, a team password manager adopted, and MFA enabled
  on Verpex, PaymentCloud/NMI, the registrar and email, before public launch.

---

## Launch blockers

These are not engineering tasks. They are decisions and confirmations the build cannot make
for itself, and each one blocks a specific flow.

1. **Verpex Node.js capability — blocks deployment.** The corpus establishes Verpex as the
   host but never confirms the plan supports persistent Node processes plus MongoDB.
   Recommended resolution: keep Verpex for the static frontend and DNS, run this API on a
   node-capable platform with MongoDB Atlas. Decide before staging is built.
2. **MCC 8398 versus hardcover sales — blocks `HARDCOVER_PURCHASABLE`.** The Payarc merchant
   account is MCC 8398 (charitable). Whether product sales may run through it, or whether a
   second MID with a retail MCC is required, must be answered by PaymentCloud/Payarc and the
   accountant. Related and equally blocking: the e-commerce MID is marked "Stage Only" and
   must be confirmed live; no hardcover price exists anywhere in the corpus, so `priceCents`
   ships `null` and the purchase flow cannot activate until the founder sets it; Michigan
   sales-tax handling must be decided.
3. **Manuscript release certification — blocks the reading path.** The Public Founding
   Edition must be produced and signed off separately from the Confidential Development
   Edition, and only `full_manuscript` is certified today — which is why `AGE_LAYER_ENABLED`
   ships `false`. No confidential marker may appear in any publicly servable unit.
4. **Tax-deductibility language — blocks receipt copy.** No confirmed 501(c)(3)
   determination exists in the corpus. Receipts therefore say "One Global People will provide
   tax documentation as applicable" and must not claim deductibility until counsel confirms
   status.
5. **Email provider — blocks every outbound message.** No provider has been chosen. The
   `log` transport delivers nothing; the `smtp` transport refuses clearly rather than
   pretending. Beta welcomes, receipts and transcript delivery all depend on this.

---

## Open contract questions carried in code

Each of these is annotated at the point where it matters:

- **Sharing thresholds.** The "K1.3+ threshold model" is referenced but never defined and no
  numeric thresholds exist. `SHARING_WINDOW_NODE_TYPES` in `config/constants.js` encodes the
  conservative default: windows open only at validated `decompression_window`,
  `human_reconnection`, `return_window` and `convergence_threshold` nodes, and
  "Become Family." renders only at validated `convergence_threshold` nodes.
- **Minimum contribution.** No amount exists in the corpus. `amountCents` is validated as a
  non-negative integer; a floor belongs in commerce configuration once the founder sets one.
- **`skipped` in event payloads.** The state machine back-emits bypassed canonical events
  with `skipped: true`, which the §3 per-event whitelist does not list.
  `EVENT_PAYLOAD_COMMON_FIELDS` reconciles this without editing the contract map; use
  `allowedPayloadFields(name)` rather than reading `EVENT_PAYLOAD_FIELDS` directly.
