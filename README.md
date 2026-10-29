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
                                          │
                               Admin Notification Provider
                                          │ official HTTPS
                                          ▼
                                       Telegram
                                         ▼
                        Private Gateway  (GATEWAY_API_KEY, loopback)
                                         │
                                        n8n  (Schedule Trigger → HTTP Request)
```

Primary documents: `docs/ALVERON_API.md`, `docs/ALVERON_DATABASE.md`, `docs/ALVERON_EVENTS.md`, and
`docs/INTEGRATION_ANALYSIS.md` for contracts/gaps. Phase documents are historical snapshots; use
`deploy/OPERATOR_RUNBOOK.md`, `n8n/README.md`, and the current tests for operational status.

## What is implemented

- **Typed, read-only Alveron client** — confirmed admin-login, order reads, and the verified referral-processing trigger only.
  Single-flight cached sessions with expiry-based re-authentication (same endpoint; no Supabase refresh calls).
- **Resilient HTTP** — timeouts, explicit backoff, serialized scheduling (default ≤ 40 req/min, well under
  Alveron's 60/min), retries only for 429/5xx/network, never for 400/401/403/404 or malformed responses.
- **Gateway-owned SQLite ledger** — atomic conditional upsert claims, owner-fenced completion,
  `PENDING/SUCCESS/FAILED`, bounded retries, permanent suppression after success, no stale auto-reclaim
  (ambiguous sends stay `PENDING` for manual reconciliation).
- **Private gateway** (`node:http`, loopback) — paid-order, referral, product-request, low-stock, order-operations,
  payment-reconciliation, shipping-SLA, system-health, and sanitized automation-error routes plus health;
  constant-time key check; strict JSON bodies and sanitized responses.
- **Email provider abstraction** — `EMAIL_PROVIDER=resend` is a real server-side Resend adapter
  (`POST https://api.resend.com/emails`, branded escaped HTML, request timeout, transient/permanent
  classification). `console` is **simulated** (development only); `unknown` fails closed. The Resend
  key, sender and customer address are never logged, returned, or placed in n8n workflow JSON.
- **Customer-email safety mode** — `ALVERON_AUTOMATION_MODE` = `live` | `test` | `disabled`.
  `test` intercepts the customer confirmation (simulated, no send) while Telegram admin alerts keep
  running; `disabled` never sends it. Mode-scoped ledger keys prevent a test/disabled run from
  suppressing a later live send.
- **Telegram admin provider** — official HTTPS `sendMessage`, gateway-owned secrets, destination hash in the
  idempotency namespace, conservative 1.1-second/20-per-minute limits, bounded response reads, and isolated failure states.
- **Admin notification abstraction** — one `AdminNotificationProvider` interface with Telegram as a single
  channel behind `AdminNotificationService`; business workflows depend on the abstraction, never on Telegram,
  so a future channel needs no business-logic change.
- **Product-sourcing request alerts** — reads `GET /admin/product-requests` (admin-scoped, read-only). Identity
  is required for idempotency; absent display fields are omitted rather than guessed, and the private
  reference image is never attached.
- **Inventory alerts** — reads `GET /products` and compares `variants[].stock` against each product's own
  `low_stock_alert`, skipping products that do not track inventory. A positive-but-low level is a `LOW STOCK`
  warning; zero is a distinct `OUT OF STOCK` warning. Deduplicated per variant and stock level, so 2 → 0 alerts
  again while a level that stays put stays quiet. A **restock** alert is raised only on the observed
  `previous <= 0 -> now > 0` transition, using last-observed stock kept in the ledger's local state table.
- **Order lifecycle notifications** — reads `GET /orders` and, for statuses Alveron reports
  (`processing`/`packed`/`ready_for_shipment`/`shipped`/`in_transit`/`ready_for_pickup`/`picked_up`/
  `delivered`/`cancelled`), sends the admin an operational alert **and** the customer a branded transactional
  email. `paid` is excluded (owned by the paid-order workflow); return/refund statuses are excluded (Alveron's
  returns module already emails the customer). Idempotent per order + status; the mode-aware provider owns the
  live/test/disabled gate. Read-only; never calls a status/fulfilment PATCH.
- **Automation outbox consumer** — drains Alveron's `automation_events` outbox (typed read/ack) for
  product-request status changes and order-issue alerts; acknowledges only after handling, leaves unknown event
  types pending and alerts. This is the event-driven backbone; the gateway never writes business state.
- **Daily operations summary** — one owner/admin digest per business day (orders, fulfilment, inventory,
  product requests, Alveron health) through the existing admin channel, idempotent per business date. Finance
  figures stay with the finance workflows.
- **Payment reconciliation** — scheduled, read-only scan for provable anomalies: `VERIFICATION_FAILED`,
  `DUPLICATE_PAYMENT`, `PROVIDER_PAID_NOT_CONFIRMED`, `AMOUNT_MISMATCH`. It never edits payment state; Alveron
  exposes no reconciliation endpoint, so the only correct action is a human-review alert.
- **Shipping SLA** — alerts when paid orders remain unshipped past `SHIPPING_SLA_HOURS`; never marks an order
  shipped. Orders whose age cannot be proven are reported as `unknownAge` rather than guessed.
- **System health** — reports only observable components (n8n, gateway, Alveron probe, Telegram configured).
  Email and Paystack are never probed (no provider secret is permitted in a health check).
- **Finance automation (fail-closed)** — seven read-only workflows consume Alveron's authoritative
  finance contract (`docs/FINANCE_API_CONTRACT.md`): daily report, weekly report, reconciliation,
  expense review, supplier payables, review digest, a deterministic anomaly monitor, and a typed
  `finance_events` outbox consumer. Every figure is consumed verbatim; only explicitly-labelled
  presentation metrics (period change, ratios) are computed. **Alveron serves these endpoints**
  (verified read-only against the deployed API). If an endpoint ever returns 404/5xx, the client
  retags it `FINANCE_ENDPOINT_UNAVAILABLE` and sends one CRITICAL `FINANCE_UNAVAILABLE` alert
  instead of inventing numbers. The finance client is a typed extension of `AlveronClient`
  (`FinanceClient` + `FinanceEventClient`) with strict response schemas.
- **n8n workflow files (inactive)** — paid-order, referral-qualification, product-request, low-stock,
  order-operations, payment-reconciliation, shipping-SLA, system-health, the eight finance workflows
  (including the finance outbox consumer), the automation-events consumer, the daily-operations summary,
  and the shared error-classification workflow. Every file pins a stable `id` and the shared error binding,
  stays `active:false`, and the gateway URL is pinned to loopback with the gateway key held only as an n8n
  Header Auth credential.

## Connecting to the live Alveron API

`https://api.alveronfashion.com/api` is **CONFIRMED live** (probed read-only; admin reads correctly 401 unauthenticated).
The exact credentials, permissions, endpoints, VPS configuration, and remaining prerequisites are documented in
**`docs/LIVE_ALVERON_CONNECTION_REQUIREMENTS.md`**. HTTPS remote access is now implemented only with explicit
opt-in; live integration remains blocked on operator prerequisites such as the service account, VPS Node version,
supplied Resend credentials + verified sender, n8n credential binding, and approved live test data.

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

## Telegram admin notifications

Telegram is an **admin notification channel only**. Alveron stays the source of truth, and a Telegram
failure never fails an order, payment, product request, referral or automation run.

```text
Alveron event ──► existing API read ──► gateway workflow ──► AdminNotificationService
                                                            ├─► ledger claim (idempotency)
                                                            └─► TelegramAdminNotificationProvider
                                                                 └─► HTTPS sendMessage ──► admin phone
```

- **One provider, no scattered API calls.** `AdminNotificationProvider` (`src/providers/admin/index.ts`) is the
  only surface business code touches. Telegram is one implementation; another channel is additive.
- **n8n never sees Telegram.** Workflows only ever POST to the loopback gateway. There is no Telegram node, no
  bot token in workflow JSON, and no Telegram passthrough route.
- **Idempotency** is the existing ledger, keyed `namespace:eventKey` — e.g. `paid-order:<orderId>`,
  `product-request:<requestId>`, `low-stock:<variantId>:<stock>`, `automation-error:<hash>`. A retry cannot
  produce a second alert. Low stock is additionally deduplicated per stock level so a variant that stays below
  its threshold alerts once and then stays quiet.
- **Failure isolation.** A failed notification is logged and recorded (`FAILED`, or `PENDING` when the outcome
  is ambiguous) and the business run still reports success. Telegram has no idempotency key, so an ambiguous
  result is never auto-retried; it needs human reconciliation.
- **Secrets** live only in the ignored, mode-`600` `deploy/gateway.env` as `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_ADMIN_CHAT_ID`. Both are required together; the admin chat is server-side configuration and cannot
  be supplied by a caller or the frontend.
- **Rate limits** are handled internally: one message per 1.1s, a conservative 20/minute ceiling, `retry_after`
  aware cooldown, and per-run alert caps (25 product-request, 20 low-stock).

The optional daily summary is **not implemented**: `GET /admin/stats` exposes only lifetime totals and
`GET /admin/analytics` exposes `dailyOrders`/`dailyRevenue`, so per-day paid-order, pending-payment and
referral counts are not obtainable without the full-list order scan already recorded as gap G-1. See
`deploy/OPERATOR_RUNBOOK.md` §5 for the measured detail.

## n8n

See `n8n/README.md`.

## Verified commands (Node 24, Windows PowerShell)

```powershell
Set-Location 'C:\dev\alveron_n8n'
npm ci --no-audit --no-fund        # dev deps only: typescript + @types/node (zero runtime deps)
npm run typecheck                  # tsc --noEmit
npm test                           # build + node --test "dist/tests/**/*.test.js"
```

`npm test` compiles to `dist/` and runs unit, contract, mock end-to-end, and security tests. The live Alveron
test reports `SKIPPED / NOT RUN` unless its separate prerequisites are configured. Telegram tests always use an
injected mock; `npm run test:telegram` is the only real-send command and is intentionally excluded from the suite.

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
`ADMIN_ALERT_EMAIL`, `LEDGER_DATABASE_URL` (`sqlite:` path), `EMAIL_PROVIDER` (`unknown`|`console`|`resend`).
When `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and (optionally) `RESEND_FROM_NAME`
are required. Optional: `LOG_LEVEL`, `GATEWAY_HOST` (loopback only), `GATEWAY_PORT`, `HTTP_TIMEOUT_MS`,
`HTTP_MAX_RETRIES`, `HTTP_MAX_REQUESTS_PER_MINUTE` (≤40), `FEATURE_ENABLE_ALVERON_WRITES` (must stay
`false`), `ALVERON_AUTOMATION_MODE` (`live`|`test`|`disabled`), `ALVERON_ORDER_PAGE_SIZE` (1–1000,
default 100), `ALVERON_ORDER_MAX_PAGES` (1–100, default 20),
`REFERRAL_QUALIFICATION_POLL_MINUTES` (5–1440, default 60), `PAID_ORDER_POLL_MINUTES` (5–1440, default 15).
Telegram names are `TELEGRAM_PROVIDER`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, and
`TELEGRAM_TIMEOUT_MS`; real values belong only in ignored secret configuration.

The Alveron service account must be provisioned by the Alveron owner (Q2): a Supabase-backed user with
`profiles.role='admin'`, an **active** `employees` row with RBAC role slug `admin`, matching user identities.
This repository never creates accounts.

## n8n

See `n8n/README.md`. Workflow JSON is inactive and credential-free; import via the n8n editor or
`npm run n8n:import` (requires the n8n CLI on PATH; imports stay deactivated by default). The Telegram change
did not import, execute, or activate any workflow in the real n8n instance.

## Hard limits

- Production mode accepts only a loopback API URL or an explicitly opted-in HTTPS API URL; plain-HTTP remote URLs are refused. Production mode rejects the simulated console email provider.
- `FEATURE_ENABLE_ALVERON_WRITES` must remain `false`; the client has no write methods at all.
- Order discovery uses Alveron's explicit `GET /orders?limit=&offset=` pagination, deduplicated by
  order id and bounded by `ALVERON_ORDER_MAX_PAGES`. G-1 (the unbounded full-list scan) is resolved;
  a scan that reaches the page ceiling is bounded rather than infinite, and the next scheduled run
  continues from the same deterministic order (newest first).
- The referral workflow calls `GET /referrals/admin/stats`, which invokes Alveron's own
  `processPendingReferrals()` for **all** pending referrals; it reports no processed count, so the automation
  never claims one.
- Referral reward alerts are event-based, not run-based: the workflow persists the last observed aggregate
  stats (in the existing SQLite state table) and sends a Telegram alert only when the `rewarded` count
  increases. Hourly runs with no new reward send nothing. Alveron exposes aggregates only, so the alert uses a
  safe reward-batch reference and marks the per-reward amount as not reported rather than guessing it.
- No referral automation beyond triggering Alveron's own logic (no eligibility/reward/credit rules here).
- **Blocked by the Alveron API (no placeholder workflows created):** referral customer notifications (no
  per-referral events), abandoned-cart reminders (no safe cart identity/consent/inactivity API), customer
  restock interest (no interest table/signup API), marketing campaigns (no consent/audience/unsubscribe API),
  and AI content / customer-service intelligence (no AI provider + human approval boundary). See
  `n8n/README.md` for the exact Alveron-side capability each one needs.
- See `docs/PHASE_5_IMPLEMENTATION.md` for the full Phase 5 record.
