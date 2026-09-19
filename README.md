# Alveron Automation (`alveron-automation`)

Separate automation/integration layer for **Alveron Fashion**. Alveron remains the **source of truth** for all
business data and rules (customers, products, orders, payments via Paystack, referrals, Alveron Credit,
shipping, returns). This repository owns **orchestration only**: it never modifies Alveron, never touches
Alveron's database, and never handles Paystack secrets or a Supabase service-role key.

```
ALVERON (confirmed API only) ──► Alveron Client (auth + HTTP + schemas)
                                        │
                                        ▼
                          Paid-Order Workflow (this repo)
                                   │           │
                                 Ledger    Email Provider
                                   └─────┬─────┘
                                         ▼
                        Private Gateway  (GATEWAY_API_KEY, loopback)
                                         │
                                        n8n  (Schedule Trigger → HTTP Request)
```

Primary documents: `docs/ALVERON_API.md`, `docs/ALVERON_DATABASE.md`, `docs/ALVERON_EVENTS.md`,
`docs/INTEGRATION_ANALYSIS.md` (contract + gaps), `docs/PHASE_4_IMPLEMENTATION_PLAN.md`,
`docs/PHASE_4_IMPLEMENTATION.md` (current, honest implementation status — **read it before trusting any claim**).

## What is implemented (Phase 4, development-only)

- **Typed, read-only Alveron client** — `POST /auth/admin-login` + `GET /orders`, `GET /orders/:id` only.
  Single-flight cached sessions with expiry-based re-authentication (same endpoint; no Supabase refresh calls).
- **Resilient HTTP** — timeouts, explicit backoff, serialized scheduling (default ≤ 40 req/min, well under
  Alveron's 60/min), retries only for 429/5xx/network, never for 400/401/403/404 or malformed responses.
- **Gateway-owned SQLite ledger** — atomic conditional upsert claims, owner-fenced completion,
  `PENDING/SUCCESS/FAILED`, bounded retries, permanent suppression after success, no stale auto-reclaim
  (ambiguous sends stay `PENDING` for manual reconciliation).
- **Private gateway** (`node:http`, loopback) — one workflow route + health; constant-time key check; strict
  JSON body; sanitized responses (no tokens, no customer PII).
- **Email provider abstraction** — `console` adapter is **simulated** (sanitized metadata only; no delivery).
  `EMAIL_PROVIDER=unknown` fails closed. Real providers are a later decision (Q4).
- **n8n workflow files (inactive)** — paid-order workflow, referral-qualification workflow and the shared
  error-classification workflow. n8n holds only `GATEWAY_BASE_URL` (non-secret) and the gateway key as an n8n
  Header Auth credential.

## Connecting to the live Alveron API

`https://api.alveronfashion.com/api` is **CONFIRMED live** (probed read-only; admin reads correctly 401 unauthenticated).
The exact credentials, permissions, endpoints, VPS configuration and the one security-reviewed repository change
required to connect the gateway are determined in **`docs/LIVE_ALVERON_CONNECTION_REQUIREMENTS.md`** — including the
currently-missing prerequisites that keep live integration **BLOCKED** (service account, VPS Node ≥ 22.5 check,
remote-URL opt-in approval, live referral test data).

## Runtime verification (Phase 6)

A self-hosted **n8n 2.39.8** (pinned stable, re-verified 2026-09-18) runtime plus the private gateway were
brought up locally for verification. Because the live Alveron dev API is **UNKNOWN/unreachable** and no
service-account credentials were supplied, the chain was verified against a **local mock Alveron**
(`node scripts/mock-alveron.mjs 4600`) — **synthetic data only, never live Alveron**.

```powershell
# 1. mock upstream (synthetic)            2. gateway (env file, git-ignored)         3. verify
node scripts/mock-alveron.mjs 4600
node scripts/run-gateway-with-env.mjs .n8n-runtime/.env.runtime
node scripts/runtime-verify.mjs        # 11/11 checks, incl. duplicate suppression
# 4. pinned n8n runtime (detached; see deploy/OPERATOR_RUNBOOK.md)
node scripts/run-n8n-dev.mjs .n8n-runtime/.env.n8n
```

**Verified at runtime:** gateway health/key enforcement; referral first run `completed` with
`sideEffectInvoked: true` and `processedCount: null`; same-window repeat `duplicate` with **no second upstream
call**; paid-order `processed: 1` then `skipped`; no secrets in responses; **gateway restart keeps the ledger**
(same window still `duplicate` after restart).

**NOT verified here (do not assume otherwise):** live Alveron connectivity and live referral data (**BLOCKED** —
no confirmed dev URL, no service account), and n8n-side import/execution/scheduled-run/restart (**NOT RUN** — the
n8n CLI/server boot exceeds this shell's 30-second command ceiling). See `docs/PHASE_6_IMPLEMENTATION.md` for the
full record and the operator runbook (`deploy/OPERATOR_RUNBOOK.md`) for the exact deployment commands.

## Scheduled referral qualification (Phase 5)

The first scheduled automation: it triggers **Alveron's own** `processPendingReferrals()` on a cron-style
cadence. No referral rule lives here.

```text
n8n Schedule ──► POST /internal/workflows/referral-qualification/run ──► gateway
                     └─► GET /referrals/admin/stats  (Alveron runs processPendingReferrals() itself)
```

- Endpoint: `GET /referrals/admin/stats` — **CONFIRMED** (Alveron source) to invoke the global
  `processPendingReferrals()` before responding; requires `@Roles('admin')`, which the service account has.
- Scope: **all pending referrals globally** (verified in source) — no customer enumeration is performed.
- Honesty: Alveron swallows processing errors, so the result reports `sideEffectInvoked` and
  `processedCount: null` — never an invented count.
- Duplicate suppression is per **window** (`referral-qualification:{windowId}`): n8n retries/replays within a
  window are no-ops, while the next scheduled window always runs.
- Failure responses are `502` with an explicit category; a duplicate is a **200** no-op.

## n8n

See `n8n/README.md`.

## Verified commands (Node 24, Windows PowerShell)

```powershell
Set-Location 'C:\dev\alveron_n8n'
npm ci --no-audit --no-fund        # dev deps only: typescript + @types/node (zero runtime deps)
npm run typecheck                  # tsc --noEmit
npm test                           # build + node --test "dist/tests/**/*.test.js"
```

`npm test` compiles to `dist/` and runs unit, contract, mock end-to-end and security tests
(currently 25 passing). `tests/contract/end-to-end.test.ts` uses a **local mock Alveron HTTP server with a
synthetic already-paid order** — it is not a live Alveron test and never creates or modifies orders.

## Optional live development check (Step 30)

```powershell
# Requires a real DEVELOPMENT Alveron API + a real development service account + disposable ledger file.
$env:ALVERON_API_BASE_URL='http://localhost:4000/api'
$env:ALVERON_SERVICE_EMAIL='…'      # from your secret store
$env:ALVERON_SERVICE_PASSWORD='…'
$env:ADMIN_ALERT_EMAIL='…'
$env:LEDGER_DATABASE_URL='sqlite:./data/live-dev.sqlite'
$env:EMAIL_PROVIDER='console'
npm run test:live
```

- Without prerequisites: reports **SKIPPED / NOT RUN** (never fabricates an environment).
- With prerequisites: verifies connectivity, authentication and paid-order **discovery** against real dev data.
- Notifications run **only** with `LIVE_CONFIRM_NOTIFICATIONS='true'`, and only via the simulated console
  provider. If no genuinely paid dev order exists: **STOP** (Step 30 forbids manufacturing one).

## Run the gateway locally

```powershell
# 1. fill the required values from your secret manager (never commit them)
Copy-Item .env.example .env   # then edit; see .env.example for names
# 2. verify configuration
npm run verify:env
# 3. check read-only connectivity (GET /orders only; reports counts, no PII)
npm run check:connectivity
# 4. start the private gateway (loopback, development only)
npm run gateway
```

Required environment variables (values from your secret store — **never** in files committed to git):
`ALVERON_API_BASE_URL`, `ALVERON_SERVICE_EMAIL`, `ALVERON_SERVICE_PASSWORD`, `GATEWAY_API_KEY` (≥32 chars),
`ADMIN_ALERT_EMAIL`, `LEDGER_DATABASE_URL` (`sqlite:` path), `EMAIL_PROVIDER` (`unknown`|`console`).
Optional: `LOG_LEVEL`, `GATEWAY_HOST` (loopback only), `GATEWAY_PORT`, `HTTP_TIMEOUT_MS`, `HTTP_MAX_RETRIES`,
`HTTP_MAX_REQUESTS_PER_MINUTE` (≤40), `FEATURE_ENABLE_ALVERON_WRITES` (must stay `false`),
`REFERRAL_QUALIFICATION_POLL_MINUTES` (5–1440, default 60), `PAID_ORDER_POLL_MINUTES` (5–1440, default 15).

The Alveron service account must be provisioned by the Alveron owner (Q2): a Supabase-backed user with
`profiles.role='admin'`, an **active** `employees` row with RBAC role slug `admin`, matching user identities.
This repository never creates accounts.

## n8n

See `n8n/README.md`. Workflow JSON is inactive and credential-free; import via the n8n editor or
`npm run n8n:import` (requires the n8n CLI on PATH; imports stay deactivated by default). **n8n runtime
behaviour (import, trigger, error workflow) has NOT been verified in this phase** — no n8n instance was
installed here.

## Hard limits

- Development only: config refuses `NODE_ENV=production` and non-loopback API URLs (G-10: production URL UNKNOWN).
- `FEATURE_ENABLE_ALVERON_WRITES` must remain `false`; the client has no write methods at all.
- Discovery polls the full `GET /orders` list (G-1) — no pagination exists in Alveron; no completeness guarantee.
- The referral workflow calls `GET /referrals/admin/stats`, which invokes Alveron's own
  `processPendingReferrals()` for **all** pending referrals; it reports no processed count, so the automation
  never claims one.
- No referral automation beyond triggering Alveron's own logic (no eligibility/reward/credit rules here).
- See `docs/PHASE_5_IMPLEMENTATION.md` for the full Phase 5 record.
