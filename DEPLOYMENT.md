# Deployment

The flow is locked (§9.9, §7.13):

```
online git repository  →  staging (QA + stakeholders)  →  public release
```

Staged private testing precedes public opening. The Founding Reader beta runs on staging, at
`/openingarc`, before any public state is reachable.

---

## 1. Topology

**[OPEN QUESTION — §9.9]** The corpus establishes Verpex as the host but never confirms the
plan supports persistent Node processes and MongoDB. This must be decided before backend work
is deployed, not after.

| Option | Shape | Assessment |
|---|---|---|
| **(a) [PROPOSED, recommended]** | Verpex serves the static frontend and DNS; the API runs on a node-capable platform (Hetzner, DigitalOcean, Render, Railway or Fly); MongoDB Atlas | Keeps the existing host and domain arrangements; puts the API somewhere designed for a long-lived process; Atlas gives backups and point-in-time recovery without operating a database |
| (b) | A Verpex VPS tier, self-managed Node and Mongo | One vendor, one bill; every hour of database operations becomes the Systems Architect's |
| (c) | Migrate off Verpex entirely | Founder approval required |

The frontend is a static bundle either way — the backend serves no static assets.

Note that the reading path is deliberately cheap to host: certified releases are immutable and
infinitely cacheable (§9.7), so reader growth costs the origin nothing. The cost curve follows
events and sessions, not readers.

---

## 2. Environments

| | Staging | Production |
|---|---|---|
| Host | `staging.oneglobalpeople.org` | `oneglobalpeople.org` |
| Access | Basic auth or an IP allowlist | Public |
| Indexing | `noindex` | Indexed |
| Database | **Separate database.** Never the production one. | Production |
| Payments | NMI **test-mode** key | Live key |
| Content | Beta Reader Edition v2.0 | Public Founding Edition only |
| Seed data | Fixtures | Certified release |

Stakeholder QA happens on staging — that is where the 5/19/26 huddle decision put it.

A staging environment that shares a database with production is not a staging environment. The
separation is what makes it safe to run `scripts/seed.mjs --drop` there.

---

## 3. Configuration

Every variable is documented in `.env.example`. Secrets live in the host secret store and
nowhere else — never in the repository, never in a `VITE_` variable, never in Slack.

Required in production, and the server refuses to boot without them:

```
MONGODB_URI            MONGODB_DB
SESSION_TOKEN_SECRET   ADMIN_JWT_SECRET   RECEIPT_SIGNING_SECRET
PUBLIC_ORIGIN          CORS_ORIGINS
```

Required before live payments:

```
NMI_SECURITY_KEY           # private Payment API key — server-side only, ever
NMI_COLLECT_JS_KEY         # public tokenization key; also given to the frontend
NMI_WEBHOOK_SIGNING_KEY
```

**Rotating `SESSION_TOKEN_SECRET`.** Put the retiring key in `SESSION_TOKEN_SECRET_PREVIOUS` and
the new key in `SESSION_TOKEN_SECRET`. Both verify during the window; only the new one signs.
Remove the previous key once the window closes. Rotating without the grace window cuts off every
reader mid-sentence, which is exactly the kind of avoidable harm the platform exists not to do.

---

## 4. First deployment

```bash
# 1. Schema and constraints. Validators first, then indexes.
node scripts/ensure-indexes.mjs --dry-run    # read the plan
node scripts/ensure-indexes.mjs

# 2. The certified release and its governance records.
node scripts/ingest-manuscript.mjs           # regenerate from the certified DOCX
node scripts/seed.mjs --dry-run
node scripts/seed.mjs

# 3. At least one administrator. MFA is not optional.
ADMIN_PASSWORD='…' node scripts/create-admin.mjs --email=… --role=founder

# 4. Start.
npm start
```

`ensure-indexes` exits non-zero if a **unique** index could not be applied. That is deliberate:
without it the application assumes a constraint the database is not enforcing, and a duplicate
`tokenHash` is a session collision while a duplicate NMI `transactionId` is a double charge.

After seeding, three things are inert on purpose and need a human before they operate:

- resonance nodes are `qa_status.validated: false` — §3.6.3 makes human review a gate
- sharing prompts are `active: false` with `requires_human_review: true`
- `products.priceCents` is `null`, so the hardcover purchase flow cannot activate

---

## 5. CI/CD

**[PROPOSED]** GitHub Actions.

On every pull request:

```bash
cd Backend  && npm ci && npm run lint && npm test
cd frontend && npm ci && npm run lint && npm run check:copy && npm run check:tokens && npm run build
```

The backend suite needs no database — 84 tests run against an in-memory stand-in — so CI stays
fast and hermetic.

Three of those checks are governance rather than hygiene, and a failure is not a style
disagreement:

| Check | What a failure means |
|---|---|
| `check:copy` | A prohibited term from `rules.json` reached user-facing copy |
| `test/prohibited-data.test.js` | A profiling field entered the data model |
| `check:tokens` | The canvas and the DOM would render different colours |

Merge to `main` deploys to staging automatically. **Production is a manually approved job** —
the founder/architect gate. Rollback is a redeploy of the previous tag; migrations stay
backward-compatible one release back.

---

## 6. Backups

- Nightly encrypted snapshots with point-in-time recovery (Atlas, or `mongodump` to encrypted
  off-host storage)
- **Quarterly restore testing.** A backup nobody has restored is a hypothesis, and the corpus
  names tested restores explicitly.
- Backup redundancy across providers
- Content is doubly protected: `content_versions` snapshots in the database, and the manuscript
  sources under git

Backups use a separate credential from the application. The API's Mongo user has `readWrite` on
the application database and nothing more.

---

## 7. Observability

- **Logs** — structured pino JSON: route pattern, status, duration, correlation id. No IP, no
  session token, no PII, no reading position. Fastify's own request log is disabled precisely
  because it records the remote address and the raw URL, and a URL can carry an opaque share or
  receipt token. 30-day retention.
- **Metrics** — Prometheus format on a private port: request rates and latencies, event-flush
  lag, Mongo op timings, NMI success and latency, webhook verification failures, rate-limit trips.
- **Errors** — a self-hosted tracker (GlitchTip or self-hosted Sentry). No third-party SaaS
  receives payloads.
- **Product analytics** — the private admin dashboard only, computed from the first-party
  `events` collection. No Google Analytics, no PostHog, no pixels.

Alarm on: health check failure, a spike in webhook signature failures, payment errors, event
backlog growth, backup failure.

---

## 8. Scaling, when it is needed

The load profile cooperates: content is static and CDN-served, writes are dominated by an
append-only event stream, and sessions are single-document operations.

1. **Stateless API** — add nodes behind the load balancer. The two stateful concessions are the
   in-memory rate limiter and the event buffer, and both have a declared Redis path.
2. **Event pipeline** — stage 1 is the in-process buffer that ships today; stage 2 is Redis +
   BullMQ; stage 3 is a managed stream. The `POST /events` contract does not change across them.
3. **MongoDB** — a 3-node replica set at launch. Shard `events` on `{ sessionId: 'hashed' }` and
   `reading_sessions` on `{ _id: 'hashed' }` when the time comes. Content collections never
   shard: they are small and cached.
4. **Metrics** — move to nightly rollups so dashboards never scan raw events.

The module boundaries in `src/modules/` are the extraction seams if a service ever needs to be
split out. There are no cross-module joins on hot paths, so nothing here requires a rewrite to
grow — which is the whole point of §1.7.
