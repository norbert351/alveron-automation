# Alveron + n8n Integration Analysis

**Status:** ANALYSIS ONLY — no implementation. Awaiting approval before Phase 4 (integration layer) and Phase 5 (first workflow).
**Date:** 2026-09-16
**Repository:** `alveron-automation` (working directory on this machine: `C:\dev\alveron_n8n`)
**Author:** automation integration analysis

---

## 0. How to read this document

Every statement carries one of four labels:

| Label | Meaning |
|---|---|
| **CONFIRMED** | Verified against the Alveron source code (`C:\dev\alveron\apps\api`) or the official n8n documentation/source. |
| **DOCUMENTED** | Stated in `docs/ALVERON_API.md`, `docs/ALVERON_DATABASE.md` or `docs/ALVERON_EVENTS.md`, but not independently re-verified in this pass. |
| **PROPOSED** | A design suggestion from this analysis. **Does not exist yet.** |
| **UNKNOWN** | Not determinable from documentation or source. Must be confirmed by a human before it is relied on. |

### Sources used

| Source | Role |
|---|---|
| `docs/ALVERON_API.md` | Primary Alveron integration contract (read in full). |
| `docs/ALVERON_DATABASE.md` | Primary Alveron data-model reference (read in full). |
| `docs/ALVERON_EVENTS.md` | Primary Alveron event reference (read in full). |
| Alveron application source: `C:\dev\alveron\apps\api` (NestJS, `src/**/*.controller.ts`, `*.service.ts`, `common/*.guard.ts`, `main.ts`, `app.module.ts`, `supabase/migrations/001–016`) | Independent verification of the three documents. Where source and documents disagree, **this document reports the discrepancy** (§16). |
| Official n8n documentation (`docs.n8n.io`) and the official n8n repository (`github.com/n8n-io/n8n`) | Source of truth for n8n capabilities and version. |

### Verification method (reproducible)

- `GET /products`-style route inventory derived from `@Controller(...)` decorators across `apps/api/src`.
- Guard semantics read directly from `apps/api/src/common/{auth,roles,permissions,employee}.guard.ts` and `modules/rbac/rbac.service.ts`.
- Order/referral/credit/returns semantics read from `modules/{orders,referrals,returns}/*.service.ts`.
- Absence checks (no scheduler, no outbound webhook, no API keys, no health endpoint, missing email module) were performed by repository-wide text search over `apps/api/src`.

### Standing constraints (from the task brief)

1. Alveron remains the single source of truth for customers, products, orders, payments, referral rules, Alveron Credit, shipping and returns.
2. Do not modify Alveron source, API or database schema from this repository.
3. Do not invent endpoints, tables, events, fields, auth mechanisms or webhook payloads.
4. Do not duplicate Paystack payment processing, referral reward calculation or credit redemption logic.
5. No secrets in workflow JSON, source, git, documentation or logs.

---

## 1. Architecture

### 1.1 Alveron (the existing system) — CONFIRMED

```text
Customer
   │
   ▼
Alveron Fashion (Next.js storefront, apps/web)
   │  Authorization: Bearer <Supabase session JWT>
   ▼
NestJS API (apps/api, global prefix /api, port 4000)
   │  Supabase service-role client  →  bypasses RLS
   ▼
Supabase / Postgres  (+ Supabase Auth, + Supabase Storage)

Side paths, all confirmed in source:
   Paystack  ──browser redirect──►  storefront  ──► POST /api/orders/paystack/initialize
   Paystack  ──server webhook───►  POST /api/orders/paystack/webhook  (HMAC-SHA512 verified)
   NestJS    ──outbound HTTP───►   api.paystack.co (initialize/verify)
   NestJS    ──outbound HTTP───►   api.resend.com  (transactional email)
   NestJS    ─outbound HTTP───►   nominatim.openstreetmap.org (reverse geocode)
```

Verified properties that matter for automation:

- **CONFIRMED** — exactly **one inbound webhook** exists: `POST /api/orders/paystack/webhook`.
- **CONFIRMED** — **no outbound webhooks**, no message queue, no `@Cron`/scheduler anywhere in `apps/api/src`.
- **CONFIRMED** — the storefront does **not** use Supabase Realtime; notifications are polled through the REST API.
- **CONFIRMED** — every external integration that exists is provider→Alveron or Alveron→provider. Nothing currently talks to an automation system.

### 1.2 Target system (PROPOSED)

```text
Alveron Fashion  (source of truth: data + business rules)
   │
   │  Alveron HTTP API   [+ documented database read path, see §8]
   ▼
Automation integration layer  ("Alveron gateway", this repository, src/integrations/alveron)
   │   auth/token lifecycle · timeouts · retries · response validation · logging · idempotency keys
   ▼
n8n  (self-hosted workflow engine, n8n.alveronfashion.com)
   │
   ▼
External services: email (Resend/SMTP), admin alert channels (Slack/WhatsApp/Telegram/email),
business notifications, scheduled referral coordination, future AI-assisted support
```

The **gateway is the only component in this repository that holds Alveron credentials** and the only component that speaks HTTP to Alveron. n8n calls the gateway with a gateway-only credential; workflows never contain Alveron tokens. Rationale and alternatives are in §5 and §7.

---

## 2. Alveron capabilities (verified)

### 2.1 Global API conventions — CONFIRMED

| Property | Value | Source of truth |
|---|---|---|
| Global route prefix | `/api` (`app.setGlobalPrefix('api')`) | `apps/api/src/main.ts` |
| Port | `PORT` (dev default `4000`) | `main.ts` |
| Body parsing | `rawBody: true` globally (required by the Paystack HMAC) | `main.ts` |
| Validation | Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform` → **unknown body fields cause 4xx** | `main.ts` |
| Rate limiting | Global `ThrottlerGuard`: **60 req/min/IP**; `POST /auth/login` additionally **5 req/min** | `app.module.ts`, `auth.controller.ts` |
| Money (store) | integer NGN (whole naira) | docs + DTOs |
| Money (Paystack/payments) | kobo = NGN × 100; enforced by RPC `amount = orders.total * 100` | `migrations/011` |
| Time | ISO 8601 / `timestamptz` | docs |
| CORS origin | **hardcoded** to `https://alveronfashion.com` / `https://www.alveronfashion.com` in source (the API docs claim `FRONTEND_URL`) — see §16.1. Irrelevant for server-to-server calls, which send no `Origin` header. | `main.ts` |
| Pagination | Present on some lists (reviews, audit logs, customers) but **absent on `GET /orders`** — see §13.1 | `orders.service.ts` |

### 2.2 Confirmed capability groups

| Area | Capability | Access class |
|---|---|---|
| Catalog | Read products, product detail, by handle, by category slug, intro collection, categories | Public |
| Catalog write | Create/update/delete product, category | Admin only |
| Pricing | `POST /orders/checkout/quote` — **dry-run** pricing (no DB writes) | Auth required |
| Cart | Create/get cart, add/update/remove lines, clear, merge (anonymous `sessionId` → user) | **Unauthenticated** (opaque cart IDs) |
| Wishlist | List/add/remove/clear | Auth required |
| Orders | `POST /orders`; `GET /orders/:id`; `GET /orders/:id/events`; `GET /orders/user/:userId` | Auth required (ownership enforced) |
| Orders admin | `GET /orders` (all), `GET /orders/session/:sessionId`, `PATCH /orders/:id/status` (strict transition map), `PATCH /orders/:id/fulfilment` | Admin only |
| Payments | `POST /orders/paystack/initialize`, `/checkout`, `/verify` (client-initiated) and inbound `POST /orders/paystack/webhook` (HMAC-verified) | Mixed / internal |
| Refunds | No refund API. Refunds are recorded on the **order status** (`refunded`, `refund_completed`) and on `returns` (`refund_completed` + amount/method/reference). Alveron never calls a Paystack refund endpoint in source. | Admin only |
| Returns (current) | `GET /returns/eligibility`, `/returns/mine`, `/returns/order/:orderId`, `POST /returns`, `POST /returns/upload`; admin: `GET /admin/returns/summary`, `GET /admin/returns`, `GET /admin/returns/:id`, `PATCH /admin/returns/:id/status`, `POST /admin/returns/:id/more-info` | Auth / Admin |
| Returns (legacy) | `POST /support/returns` + legacy admin listing (`return_requests`) — **do not automate** | Mixed |
| Support tickets | `POST /support/tickets` (public create); `PATCH /support/tickets/:id/status`, `GET /support/admin/tickets` (admin). `GET /support/tickets*` are owner-unsafe in source. | Public / Admin |
| Referrals | `POST /referrals/validate`, `GET /referrals/settings` (public); `GET /referrals/me`, `GET /referrals/me/stats` (auth); `GET /referrals/admin/all|stats`, `PATCH /referrals/admin/settings` (admin) | Mixed |
| Alveron Credit | `GET /credits/me/balance`, `GET /credits/me/transactions`, `POST /credits/me/validate` (auth). Redemption happens **inside order creation**, not via an endpoint. No admin credits endpoint exists. | Auth / none |
| Reviews | Public read (`/reviews/product/:id`, `/photo-gallery/:id`, `/summary/:id`); auth write (`POST /reviews`, `/reviews/photo`, `DELETE /reviews/:id`); admin moderation (`/admin/reviews*`) | Mixed |
| Shipping | `GET /shipping/config`, `POST /shipping/quote`, `GET /shipping/reverse-geocode` (public); admin `PATCH /shipping/settings`, `POST|PATCH|DELETE /shipping/rates` | Public / Admin |
| Coupons | `GET /coupons/validate` (public); admin CRUD under `/admin/coupons` | Public / Admin |
| Customers admin | list / detail / update / status / reset-password / resend-verification / grant-coupon | Admin · permission |
| Employees & RBAC | employee CRUD + invitations; roles/permissions CRUD | Admin · permission |
| Notifications | `GET /admin/notifications`, `/unread-count`, `PATCH /admin/notifications/read-all`, `PATCH /admin/notifications/:id/read` | Employee (active employee required) |
| Admin dashboard | `GET /admin/stats`, `GET /admin/analytics?period=`, `GET /admin/users`, `PATCH /admin/users/:id/role` | Admin only |
| Audit | `GET /admin/audit-logs`, `GET /admin/audit-logs/facets` | Admin · `system_logs:view` |
| Content / settings | announcements, banners, newsletter subscribe/unsubscribe + subscriber list, pickup locations (read only), showroom, `GET /settings/store`, upload | Mixed |

### 2.3 Confirmed *absences* in Alveron (verified by source search)

These absences define the integration gaps in §13. Each was checked directly, not assumed:

1. **No outbound webhooks of any kind.** The only outbound HTTP calls in `apps/api/src` target `api.paystack.co` (initialize/verify), `api.resend.com` (email) and `nominatim.openstreetmap.org` (reverse geocode).
2. **No scheduler or worker.** No `@Cron`, no `@nestjs/schedule`, no queue, no `setInterval`. The only periodic-ish process (`processPendingReferrals`) runs solely as a side effect of two read endpoints.
3. **No service-to-service or API-key authentication.** No API-key guard and no `x-api-key` handling exists anywhere in source. An `api_keys` permission *module* exists in the RBAC catalogue but has no implementation, controller or table. This is why §5 proposes a service **account** with a real Supabase session rather than an API key.
4. **No health/readiness endpoint.** There is no `GET /health`, `GET /status` or equivalent route.
5. **No incremental or paginated order listing.** `GET /orders` loads every order (with items and payments) into memory and filters in Node.
6. **No abandoned-cart surface.** No endpoint lists carts, and no "abandoned" concept exists in the data model.
7. **No WhatsApp/provider messaging.** `store_settings.whatsapp` is a config key plus a frontend link only; there is no server-side WhatsApp/Twilio integration.
8. **No working order email.** `orders.service.ts` dynamically `require`s `src/lib/email-templates`, which **does not exist** in the repository, so order confirmation and order-status emails fail silently (caught and logged). Returns emails and customer/employee emails via Resend **do** work when `RESEND_API_KEY` is set.
9. **No admin credits endpoint.** `CreditService.getAdminCreditStats()` exists but is not exposed by any controller.
10. **No pickup-location write API.**

---

## 3. n8n capabilities (verified against official n8n sources)

### 3.1 Version — CONFIRMED

| Item | Value |
|---|---|
| Latest **stable** release at time of writing | **n8n@2.39.6**, published 2026-09-16 |
| Maintenance line | **n8n@1.123.80** (1.x) |
| Beta (do not use in production) | n8n@2.40.0 / 2.40.1 |
| n8n 2.x model change | The active/inactive toggle was replaced by a **publish / unpublish** model (`publish:workflow` / `unpublish:workflow` CLI) |
| Licence | Community edition is under the Sustainable Use Licence; some features are licence-gated |

**Recommendation (PROPOSED):** deploy a **pinned stable 2.39.x** image by digest (never `latest`), and re-check the release channel before go-live. Do not pin 1.x or a beta.

### 3.2 Relevant n8n features — CONFIRMED

| Capability | Why it matters here | Verified detail |
|---|---|---|
| **Schedule Trigger** | The only viable trigger for Alveron event detection today (Alveron emits no outbound events) | Core trigger node; cron/interval expression |
| **Webhook node** | Reserved for future inbound integrations (forwarded provider callbacks, support-channel intake) | Test vs production URLs; methods DELETE/GET/HEAD/PATCH/POST/PUT; path with route params; **auth: Basic, Header, JWT**; IP(s) allowlist; **Raw Body** option; max payload 16 MB (`N8N_PAYLOAD_SIZE_MAX`); Respond modes (Immediately / When Last Node Finishes / Respond to Webhook node); Response Code/Data/Headers; Allowed Origins (CORS). Since n8n 1.103, HTML responses are auto-wrapped in a sandboxed iframe. |
| **HTTP Request node** | The node that calls the Alveron gateway | Authentication via credential types (predefined or generic, e.g. Header Auth); **Batching** (Items per Batch + Batch Interval in ms) to respect Alveron's 60 req/min limit; **Settings → Retry on Fail** (Max Tries, Wait Between Tries in ms) |
| **Code node (JavaScript)** | Normalisation, validation, dedupe-key derivation | `$getWorkflowStaticData` is available **only** in the JS Code node (caveat in §3.3) |
| **Execute Sub-workflow** | Shared modules (e.g. "record audit row", "notify admin") without hidden coupling between workflows | Execute Sub-workflow node + Execute Sub-workflow Trigger |
| **Error Trigger + Error workflow** | The mandatory failure path | Configured per workflow under *Workflow Settings → Error workflow*; receives `{execution:{id,url,retryOf,error:{message,stack},lastNodeExecuted,mode},workflow:{id,name}}` (fewer `execution` fields when the trigger node itself failed). `Stop And Error` node forces deliberate failure. |
| **Data tables** | **Idempotency ledger / dedupe markers** — the correct n8n 2.x tool | Project-scoped; created via Data Table node, `/datatables` API or UI; default instance limit 200 MiB (`N8N_DATA_TABLES_MAX_SIZE_BYTES`); **cannot** be read from a Code node or expression — read with a Data Table node (`Get row`) and reference its output; write with `Upsert row` |
| **Credentials** | Never place secrets in workflow JSON | Encrypted with a key auto-generated on first launch into `~/.n8n`, overridable via `N8N_ENCRYPTION_KEY` (**must be identical on all workers in queue mode**); credentials are not exported with workflow JSON; `CREDENTIALS_OVERWRITE_DATA` / `_FILE` inject credential data from environment/files |
| **Env vars and `_FILE`** | Config/secret injection without git | Any variable supports the `_FILE` suffix (Docker/Kubernetes secrets) |
| **Execution model & scaling** | Throughput and blast-radius control | `EXECUTIONS_MODE=regular|queue` (queue mode uses Redis via `QUEUE_BULL_REDIS_*`); `N8N_CONCURRENCY_PRODUCTION_LIMIT`; `EXECUTIONS_TIMEOUT` / `_MAX`; multi-main requires a licence |
| **Execution data hygiene** | Avoid retaining customer PII | `EXECUTIONS_DATA_PRUNE*` settings; `EXECUTIONS_DATA_MAX_DISPLAY_SIZE`; configurable save-on-success/error |
| **Auto-deactivation** | Safety net | `N8N_WORKFLOW_AUTODEACTIVATION_ENABLED` (default `false`) unpublishes after repeated crashed executions (`N8N_WORKFLOW_AUTODEACTIVATION_MAX_LAST_EXECUTIONS`, default 3) |
| **Workflow import/export (CLI)** | Git-managed workflow source of truth | `n8n export:workflow --all\|--id\|--projectId [--output=DIR --separate --pretty\|--backup] [--published\|--version]`; `n8n import:workflow --input=FILE\|DIR [--separate] [--userId\|--projectId] [--activeState=false\|fromJson]`. **`--activeState` defaults to `false`** (imports arrive deactivated); `fromJson` works only in queue/multi-main mode |
| **Other CLI** | Operations | `n8n execute --id`, `publish:workflow`, `unpublish:workflow`, `n8n audit` (security audit), `n8n license:info` |
| **Security env vars** | Hardening | `N8N_BLOCK_ENV_ACCESS_IN_NODE` (blocks `$env` in expressions/Code), `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES` (default true), `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS`, `N8N_MFA_ENFORCED_ENABLED`, `N8N_SECURITY_POLICY_MANAGED_BY_ENV`, `N8N_SECURITY_AUDIT_DAYS_ABANDONED_WORKFLOW` |

### 3.3 n8n limitations that shape this design — CONFIRMED

1. **`$getWorkflowStaticData` is experimental**: unavailable while *testing* a workflow (it persists only for published, trigger-invoked executions) and documented as potentially unreliable under high-frequency execution. → **Not acceptable as the primary idempotency store.** Use **Data tables** (§11) or an external store.
2. **Retry on Fail is per node**, with `Max Tries` + `Wait Between Tries (ms)`. The official HTTP Request troubleshooting documentation describes only a fixed wait — **no documented exponential backoff**. → Backoff must be **implemented explicitly** (§12) rather than assumed. Marked PROPOSED.
3. **Data tables are deliberately small-scale** (200 MiB default per instance) and are not a system of record. Store keys/state only — never customer-data dumps.
4. **Static credential types cannot refresh expiring tokens.** n8n will not renew a 1-hour Supabase bearer token inside a credential. → This is the primary technical justification for the gateway layer in §5/§7.
5. **Every inbound webhook is attack surface.** n8n offers Basic/Header/JWT auth and IP allowlists, but nothing in this integration needs a public n8n webhook today (§6).

---

## 4. Integration points

### 4.1 Catalogue

| ID | Direction | Mechanism | Access class | Status |
|---|---|---|---|---|
| **IP-1** | n8n → Alveron | Read-only admin API via gateway (`GET /orders`, `GET /orders/:id`, `GET /orders/:id/events`, `GET /admin/returns*`, `GET /referrals/admin/*`, `GET /admin/stats`) | Admin (service account) | **CONFIRMED** (endpoints exist) |
| **IP-2** | Paystack → Alveron | Existing inbound webhook `POST /orders/paystack/webhook` (HMAC-verified). n8n does **not** consume it; n8n observes resulting order/payment state | Internal only | **CONFIRMED** (exists, Alveron-owned) |
| **IP-3** | n8n → Alveron | Scheduled trigger of Alveron's own referral qualification: `GET /referrals/me/stats` (AuthGuard only) | Auth required | **CONFIRMED** (side effect verified in source) |
| **IP-4** | n8n → external | Customer notification (order confirmation / status / tracking) via the automation system's own email provider | n/a (outbound) | **PROPOSED** |
| **IP-5** | n8n → external | Admin/business alerting (Slack / WhatsApp Business / Telegram / email) | n/a (outbound) | **PROPOSED** |
| **IP-6** | n8n → Alveron | Order status write `PATCH /orders/:id/status` (strict transition map) | **Admin only — high risk** | **CONFIRMED endpoint / PROPOSED use** (not needed for workflow 1) |
| **IP-7** | n8n → Alveron | Fulfilment/tracking write `PATCH /orders/:id/fulfilment` | **Admin only** | **CONFIRMED endpoint / PROPOSED use** (later phase) |
| **IP-8** | External → n8n | Inbound n8n Webhook node (support-channel intake, or forwarding a provider callback) | n8n webhook auth | **PROPOSED** (not required for workflow 1) |
| **IP-9** | n8n → Alveron DB | Optional read-only observation of `payments` / `order_events` / `referrals` watermarks | DB-level, behind service-role | **PROPOSED — requires explicit approval** (see §8) |
| **IP-10** | Alveron → n8n | Outbound webhook from Alveron to n8n | — | **DOES NOT EXIST — gap G-2 (§13)** |

### 4.2 Detail per integration point

#### IP-1 — Read-only admin API access (the backbone)
- **Alveron side:** admin-gated read endpoints listed above; exists in source today.
- **n8n side:** HTTP Request node → gateway → Alveron API.
- **Authentication:** service account Supabase session (bearer), obtained and refreshed by the gateway (§5).
- **Request:** `GET` with query filters where the endpoint supports them. Note `GET /orders` accepts `status`, `paymentStatus`, `state`, `search` and supports **no** pagination/date filter.
- **Response:** JSON; order objects include `items: order_items[]` and `payments[]`; validation is performed by the gateway against a declared schema before n8n sees it.
- **Trigger:** Schedule Trigger (poll) — no other trigger exists today.
- **Action:** normalise into workflow items; derive idempotency keys; notify; log.
- **Failure handling:** gateway returns structured errors; node-level Retry on Fail + explicit backoff; failures escalate to the error workflow (§12).

#### IP-2 — Paystack payment confirmation (owned by Alveron)
- **Alveron side:** `POST /api/orders/paystack/webhook`, HMAC-SHA512 (`x-paystack-signature`) over the raw body, plus Paystack source-IP allow-listing when `NODE_ENV=production`; idempotent via RPC `confirm_paystack_payment`.
- **n8n side:** **no node.** n8n must not receive, verify or replay Paystack webhooks, and must not call Paystack.
- **Authentication:** not applicable to automation; the HMAC secret stays in Alveron's environment only.
- **Request/Response:** none from automation.
- **Trigger:** automation detects the *result* (order/payment state), not the event.
- **Action:** read-only consequence (see §9/§12).
- **Failure handling:** payment failures are Alveron's concern; automation must never "fix" a payment.

#### IP-3 — Scheduled trigger of Alveron's own referral qualification
- **Alveron side:** `GET /referrals/me/stats` (any authenticated caller) and `GET /referrals/admin/stats` (admin) both invoke `processPendingReferrals()`, which iterates **all** `pending` referrals and runs Alveron's own `qualifyReferral` → `awardReward` logic.
- **n8n side:** Schedule Trigger → gateway → `GET /referrals/me/stats`.
- **Authentication:** any valid session; the gateway uses the service account.
- **Request:** no body or params.
- **Response:** the caller's own referral stats (the side effect is global).
- **Trigger:** cron, e.g. hourly (PROPOSED cadence).
- **Action:** only invoking Alveron's own logic. Follow-up notifications must read Alveron's state and must **never** recompute reward amounts.
- **Failure handling:** idempotent by design (Alveron guards with an app-side check **and** a partial unique index on `credit_transactions.referral_id`), so a failed invocation is safe to retry.

#### IP-4 / IP-5 — Outbound customer & admin notifications
- **Alveron side:** none required. Order emails inside Alveron are broken (§2.3 item 8), so outbound sending is genuinely complementary, **not** duplicative. Returns emails already work inside Alveron and must not be duplicated.
- **n8n side:** email node (or HTTP Request to the chosen provider); admin alerts likewise.
- **Authentication:** provider credential stored as an n8n credential, never in workflow JSON.
- **Request/Response:** provider-specific.
- **Trigger:** downstream of IP-1 / IP-3 detection.
- **Action:** concise notification containing the minimum necessary order detail.
- **Failure handling:** node Retry on Fail; on final failure the error workflow alerts an admin. A notification failure must never mutate Alveron data.

#### IP-6 / IP-7 — Writes back into Alveron (PROPOSED, later phase, gated)
- **Alveron side:** `PATCH /orders/:id/status` (strict transition map; also writes `order_events`, `admin_logs`, a customer notification, inventory RPCs and referral cancellation) and `PATCH /orders/:id/fulfilment`.
- **n8n side:** HTTP Request via gateway — one deliberate workflow per write. **Not part of workflow 1.**
- **Authentication:** admin service account (§5).
- **Request:** validated body; `UpdateOrderStatusDto` rejects unknown fields (`forbidNonWhitelisted`).
- **Response:** the updated order.
- **Trigger:** an **explicit human action** or a strictly validated condition — never AI-initiated (§10).
- **Action:** advance order/fulfilment state.
- **Failure handling:** `400 Cannot move order from X to Y` is a **terminal, non-retryable** response → log and alert; do not retry blindly.

#### IP-8 — Inbound n8n webhook (PROPOSED)
- **Alveron side:** none.
- **n8n side:** Webhook node with Header (or JWT) auth, plus an IP allowlist where the caller has static IPs.
- **Authentication:** n8n webhook credential.
- **Request:** provider/partner payload. If a **raw-body signature** is ever required, use the Webhook node's *Raw Body* option and verify the signature in a Code node **before** any processing.
- **Response:** fast 2xx; heavy work continues asynchronously.
- **Trigger:** external system.
- **Action:** validation → classification → gateway reads → notification/escalation.
- **Failure handling:** invalid signature ⇒ 401 with no processing, and the rejection reason is logged.

#### IP-9 — Direct database observation (PROPOSED, needs approval)
See §8. Read-only, watermark-based, never writing. Requires a read-only DB role or explicit service-role approval; a service-role key must never enter this repository or n8n.

---

## 5. Authentication

### 5.1 What exists — CONFIRMED

| Fact | Evidence |
|---|---|
| The only authentication mechanism is `Authorization: Bearer <Supabase session JWT>`; `AuthGuard` validates it with `supabase.auth.getUser(token)` | `common/auth.guard.ts` |
| There is **no** API-key / service-to-service auth mechanism anywhere | repository-wide source search |
| `POST /auth/login` returns the full Supabase session object (`user` + `session` with access/refresh tokens) | `auth.service.ts` (`signInWithPassword`) |
| `POST /auth/admin-login` returns the same plus `employee`, `profile`, `mustChangePassword`; it rejects non-employees that are not legacy `profiles.role='admin'`, and rejects inactive employees | `auth.service.ts` |
| `POST /auth/login` is throttled to **5 requests/minute** | `auth.controller.ts` |
| Every route additionally sits behind a **60 req/min/IP** global throttle | `app.module.ts` |

### 5.2 Consequences for automation

1. A short-lived bearer token **cannot** be stored statically in an n8n credential: it expires and n8n cannot refresh it (§3.3 item 4).
2. Logging in on every workflow run would hit the 5/min login throttle and is wasteful.
3. The token lifecycle must therefore live in code that n8n treats as a black box.

### 5.3 Chosen approach — PROPOSED

```text
n8n  ──(gateway API key, an n8n Header-Auth credential)──►  Alveron gateway (this repo)
                                                              │ service-account email+password (env/secret store)
                                                              │ caches access token + refresh token
                                                              │ single-flight refresh (no login stampede)
                                                              ▼
                                                        Alveron API /api/...   (Bearer <Supabase session JWT>)
```

- The gateway authenticates with a **dedicated automation service account** using `POST /auth/admin-login` (preferred — it validates employee/role state and returns `employee` + `profile`).
- The gateway caches the access token and refreshes it **before** expiry. Refresh uses Supabase Auth's refresh-token grant (`POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token` with the project's publishable/anon key) — **PROPOSED; to be verified against the project's auth configuration** (JWT expiry, refresh-token rotation and lifetime). Fallback: re-login with the service-account password, kept far below 5/min by the cache.
- All configuration arrives via environment variables/secrets: `ALVERON_API_BASE_URL`, `ALVERON_SERVICE_EMAIL`, `ALVERON_SERVICE_PASSWORD`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `GATEWAY_API_KEY`, plus timeout/retry settings. Nothing hardcoded, nothing committed.
- n8n holds **only** the gateway API key (n8n Header-Auth credential) — never Alveron credentials, and never the Supabase service-role key.

### 5.4 Service-account privilege — CONFIRMED constraint (important)

Guard semantics verified in source:

| Guard | Passes when |
|---|---|
| `AuthGuard` | valid Supabase JWT |
| `RolesGuard` (`@Roles('admin')`) | `profiles.role` ∈ required roles, **or** employee RBAC role `slug` ∈ required roles, **or** employee role `is_super_admin`, **or** required roles contain `'staff'` and the user has any employee role |
| `PermissionsGuard` (`@Permissions('x:y')`) | `rbac.getPermissions(userId)` contains the permission or `'*'`. `'*'` is returned for super-admin employees **and for legacy `profiles.role='admin'`**; otherwise it is the union of the employee role's granted `role_permissions` |
| `EmployeeGuard` | an `employees` row with `status='active'` |

Implications:

- A **narrowly-scoped custom role cannot call the `@Roles('admin')` endpoints** (`GET /orders`, `GET /admin/returns*`, `GET /referrals/admin/*`, `GET /admin/stats`, …), because only the literal role slug `admin`, `is_super_admin`, or legacy `profiles.role='admin'` satisfies them. Recorded as **gap G-4** — to be raised with the Alveron owners, not worked around.
- Several services **re-check `profiles.role` directly** (`getOrderForUser`, `getOrderEvents` treat only `profiles.role` `admin`/`staff` as staff). An RBAC-admin **employee** whose `profiles.role='customer'` can therefore list all orders yet be denied `GET /orders/:id`. See §16.3.
- **PROPOSED service-account shape:** a dedicated Supabase user with `profiles.role='admin'` **and** an active `employees` row whose RBAC role slug is `admin` (so `EmployeeGuard` endpoints such as `GET /admin/notifications` also work). This is the only combination that satisfies all four guards. It is **not** least-privilege in the strict sense — which is precisely why gap G-4 matters.
- The account must be **dedicated to automation**, identifiable in `login_events` / `admin_logs`, and revocable (deactivate the employee row, rotate the password).

### 5.5 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Static Alveron token in an n8n Header-Auth credential | Expires (~1 h); no refresh path inside n8n; rotation would require editing every workflow |
| Fresh login inside each workflow | Hits the 5/min login throttle; spreads service credentials across many workflows |
| Custom n8n community node for Alveron | Maintenance/upgrade burden for no functional gain at this stage |
| Direct Postgres access for everything | Bypasses application-level authorization/validation and duplicates business logic — see §8 |

---

## 6. Webhooks

### 6.1 Alveron → n8n — CONFIRMED: **does not exist**

Alveron emits **no outbound webhooks** (§2.3 item 1). There is therefore **no event push** from Alveron to n8n today, and nothing in this design may assume one. Consequences:

- Detection of new paid orders, deliveries, returns, reviews, low stock and referral transitions must be **pull-based** (polling) until gap **G-2** is closed.
- Any "webhook trigger" workflow built today would be fiction. It is explicitly rejected.

### 6.2 Paystack → Alveron — CONFIRMED (existing, and Alveron-owned)

| Property | Verified behaviour |
|---|---|
| Endpoint | `POST /api/orders/paystack/webhook` |
| Verification | Requires `PAYSTACK_SECRET_KEY` **and** `req.rawBody`; recomputes `HMAC-SHA512(secret, rawBody)`; compares with `x-paystack-signature` using constant-time comparison. Missing signature or mismatch ⇒ `401` |
| Source-IP check | When `NODE_ENV=production`, the client IP must be one of `52.31.139.75`, `52.49.173.169`, `52.214.14.220` |
| Events handled | Only `charge.success`; every other event is acknowledged with `{received:true}` and no action |
| Payment matching | `payments.provider_reference = data.reference`; then reference + amount + currency must all match, else `400` with no state change |
| Idempotency | RPC `confirm_paystack_payment` returns `{confirmed:true, idempotent:true}` if the payment is already `SUCCESS` |
| Side effects | decrements stock, `payments→SUCCESS`, order→`paid`, clears cart lines, bumps coupon usage, writes `order_events` + `admin_logs(PAYMENT_SUCCESS)` |
| Anomaly path | insufficient stock ⇒ `payment_status='VERIFICATION_FAILED'`, order reset to `pending`, `admin_logs(PAYMENT_INVENTORY_REVIEW)` |

**Rule (PROPOSED, aligns with `docs/ALVERON_EVENTS.md`):** the automation system must **not** become a second Paystack consumer. It must not receive, verify, replay or reorder Paystack webhooks, and must not call Paystack APIs. It observes the *result* in Alveron.

> **Considered and rejected — Option A:** point Paystack's dashboard at an n8n webhook that re-emits the raw body to Alveron.
> Rejected because (i) it makes payment confirmation depend on n8n uptime — if n8n is down, customers pay and orders never confirm; (ii) it rewires **production** payment configuration, which this repository must not do; (iii) it requires byte-exact raw-body preservation, and any proxy/second consumer in the path risks breaking the HMAC contract.
> **Considered — Option B:** Alveron adds a first-class outbound event stream (webhook or queue) that n8n subscribes to. This is the correct long-term design and is recorded as gap **G-2**. It requires an Alveron-side change and is therefore **not** implemented here.

### 6.3 n8n → Alveron websockets/hooks — CONFIRMED: none

n8n → Alveron communication is ordinary outbound HTTPS (`HTTP Request` node → gateway → Alveron REST API). No webhook is involved in that direction.

### 6.4 Inbound n8n webhooks — PROPOSED (future only)

The only justified future use of n8n's Webhook node is **external → n8n → Alveron** flows that Alveron does not serve today:

| Use case | Notes |
|---|---|
| Support-channel intake (e.g. WhatsApp/email provider posts to n8n) | Requires the provider integration to be chosen first; no such integration exists today |
| Partner/system callbacks unrelated to Paystack | Only if a concrete partner requires it |

Mandatory controls for **any** future inbound webhook (PROPOSED):

1. Authenticate the caller: n8n Header/JWT auth **or** a verified raw-body signature — never "open" webhooks.
2. IP allowlist where the caller has stable egress IPs.
3. Verify signatures over the **raw body** *before* any parsing or side effect.
4. Replay protection: dedupe on a provider event id/timestamp using the idempotency ledger (§11); reject stale timestamps.
5. Respond fast (2xx) and do heavy work asynchronously; never leave the caller waiting on Alveron API latency.
6. Never log the payload wholesale (customer PII / provider secrets).

---

## 7. API communication

### 7.1 Base URL — status: **UNKNOWN / must be confirmed**

| Question | Finding |
|---|---|
| Does Alveron define a public API base URL? | **No.** `apps/api` contains no self-describing hostname. The only URL-shaped configuration is `FRONTEND_URL`, `APP_URL` and `PAYSTACK_CALLBACK_URL`. |
| Documented production URL | `docs/ALVERON_API.md` states explicitly that the production URL is **unknown and must be confirmed**. |
| `https://api.alveronfashion.com/api` (from the task brief) | **NOT CONFIRMED.** Neither the Alveron documentation nor the source contains this hostname. It is *plausible*, not verified → treated here as **UNKNOWN**. |
| What the hardcoded CORS array proves | `main.ts` allows origins `https://alveronfashion.com` and `https://www.alveronfashion.com`. Those are **frontend** origins and are *not* evidence of an API hostname. (CORS is also irrelevant to n8n/gateway calls, which are server-to-server and send no `Origin`.) |
| Dev target (this machine) | `apps/api/.env` → `PORT=4000`, `NODE_ENV=development`, `FRONTEND_URL=http://localhost:3000`; `apps/web/.env.local` → `NEXT_PUBLIC_API_URL=http://localhost:4000/api`. So the working dev base URL is `http://localhost:4000/api`. |

**Rules (PROPOSED):**

1. The base URL is **configuration, never code**: `ALVERON_API_BASE_URL` (gateway env). The same gateway must run against local, staging and production without edits.
2. Before any production cutover, confirm with the Alveron owners: the real public hostname and TLS setup, whether a reverse proxy fronts it and whether it preserves the raw body (the Paystack webhook depends on that), and the value of `NODE_ENV` (it activates the webhook IP allowlist).
3. The gateway must refuse to start in production mode when the base URL is missing — fail loudly; never silently default to localhost.

### 7.2 Configuration (names only — values live in a secret store)

| Variable | Purpose |
|---|---|
| `ALVERON_API_BASE_URL` | Alveron API root, e.g. `http://localhost:4000/api` |
| `ALVERON_SERVICE_EMAIL` / `ALVERON_SERVICE_PASSWORD` | Service-account credentials |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | Used **only** for token refresh — never the service-role key |
| `GATEWAY_API_KEY` | What n8n presents to the gateway |
| `HTTP_TIMEOUT_MS`, `HTTP_MAX_RETRIES`, `HTTP_BACKOFF_BASE_MS`, `HTTP_MAX_REQUESTS_PER_MINUTE` | Transport policy |
| `LOG_LEVEL`, `AUDIT_LOG_PATH` | Observability |
| `FEATURE_ENABLE_ALVERON_WRITES` | **Default `false`.** Gate for IP-6/IP-7 write workflows |

### 7.3 Timeouts

- Gateway: explicit connect + read timeouts on every outbound call (PROPOSED defaults: 5 s connect, 20 s read; configurable). A timeout is a **retryable** transport error.
- n8n: `EXECUTIONS_TIMEOUT` is the outer bound; HTTP Request nodes also use node-level Retry on Fail (§12).

### 7.4 Rate-limit compliance (critical, easy to get wrong)

- Alveron enforces **60 requests/minute per IP** across all endpoints, plus **5/minute** for `POST /auth/login`.
- The limit is per **source IP**. If the gateway shares an egress IP with any other client, they share the budget.
- PROPOSED policy: **single-flight, serialised** outbound calls with a minimum spacing (e.g. ≥ 1 s) and a configured ceiling well under 60/min; n8n HTTP Request **Batching** (`Items per Batch` = 1, `Batch Interval` ≥ 1000 ms) for fan-out loops; login attempts cached (a few per hour at most).
- `429` must trigger backoff (honouring `Retry-After` when present) — never an immediate retry storm. Alveron's `ThrottlerGuard` does not document a `Retry-After` guarantee → treat it as unknown and use configured backoff.

### 7.5 Request conventions

| Rule | Detail |
|---|---|
| Content type | JSON only |
| Unknown fields | **Forbidden** (`whitelist` + `forbidNonWhitelisted`) — the gateway sends only documented fields or Alveron returns 4xx |
| Money | NGN integer for store-level values; **kobo** (`NGN × 100`) only where Alveron/Paystack expects it |
| Dates | ISO 8601 |
| Payment status | Never assume casing: values in source are `SUCCESS`, `paid`, `PENDING`, `pending`, `VERIFICATION_FAILED`. Match `SUCCESS` **and** `paid` |
| Identity | Never present a customer's token as the automation identity; the gateway always uses the service account |
| PII | Request only the fields the workflow needs |

### 7.6 Response validation

- The gateway validates every upstream response against a **declared schema** before n8n sees it.
- An unexpected shape (missing `payments` array, unknown enum, an HTML error page) is treated as **failure, not as empty data** — fail closed and alert. Treating "unparseable" as "nothing to do" is how automations silently lose orders.
- Responses are normalised to a stable envelope for n8n: `{ ok, data, meta: { requestId, fetchedAt, upstreamStatus }, error? }`, so workflows never depend on raw Alveron payload shapes.

### 7.7 Error taxonomy and retry policy (PROPOSED)

| Upstream result | Classification | Action |
|---|---|---|
| 400 Bad Request | Terminal | No retry. Log + alert (usually a DTO/code mismatch → a bug) |
| 401 Unauthorized | Auth | Refresh token **once**; if it fails again, alert and stop |
| 403 Forbidden | Permission | Terminal. Alert — indicates a guard/permission gap (see G-4) |
| 404 Not Found | Terminal | Resource absent; log, no retry |
| 409 / duplicate | Idempotent | Treat as already-processed; record and continue |
| 400 `Cannot move order from X to Y` | Terminal | Invalid transition — never blind-retry |
| 429 Too Many Requests | Retryable | Backoff (honour `Retry-After` if present) |
| 5xx | Retryable | Bounded retries with backoff, then error workflow |
| Timeout / DNS / TLS | Retryable | Same as 5xx |
| Schema mismatch | Terminal | Fail closed, alert |

### 7.8 Gateway surface exposed to n8n — PROPOSED

Internal, read-first and deliberately small:

| Gateway route | Purpose |
|---|---|
| `GET /health` | Gateway liveness + Alveron reachability + token-cache state (compensates for the missing Alveron health endpoint) |
| `GET /alveron/orders` | Order list with gateway-side filtering (status / paymentStatus / since) and normalised output |
| `GET /alveron/orders/:id` | Single order + items + payments |
| `GET /alveron/orders/:id/events` | `order_events` timeline |
| `POST /alveron/referrals/process` | Invokes Alveron's own referral qualification; returns a summary |
| `POST /alveron/orders/:id/status` | **Disabled unless `FEATURE_ENABLE_ALVERON_WRITES=true`** (IP-6) |
| `POST /alveron/orders/:id/fulfilment` | **Disabled unless `FEATURE_ENABLE_ALVERON_WRITES=true`** (IP-7) |

The gateway is **not** a public API: bind it to localhost/private network and protect it with `GATEWAY_API_KEY` plus network policy. It is the only component permitted to hold Alveron credentials.

---

## 8. Database

### 8.1 What the automation system needs to understand (not to access)

The database documentation is primarily **shared vocabulary** between the two systems. Entities that matter, and why:

| Entity | Why automation cares |
|---|---|
| `orders` | Lifecycle state, payment status, totals, tracking, referral/credit linkage. Note the **two money meanings** (`total` NGN vs `payments.amount` kobo) |
| `order_items` | Snapshot line items (title/price/qty at purchase time) for notifications |
| `order_events` | The cleanest append-only **order timeline** — a natural watermark for detection |
| `payments` | Canonical Paystack record (`provider_reference` unique, `status`, `amount` kobo, `paid_at`) — the safest "was this really paid?" signal |
| `returns` (not `return_requests`) | Current returns lifecycle; the legacy table belongs to a different system |
| `referrals` / `referral_codes` / `credit_transactions` | Referral funnel `pending → qualified → rewarded` and the credit ledger. **Read-only vocabulary** — Alveron computes all amounts |
| `notifications` | Existing in-app notification stream (customer + staff fan-out) |
| `admin_logs` | Audit stream; useful for correlating automation actions with Alveron's own |
| `product_variants.stock` | Stock state (two inventory paths exist — see 8.5) |
| `store_settings.referral_program` | Authoritative referral/credit thresholds (§14.3) |
| `employees` / `roles` / `role_permissions` | Determines what the service account may do (§5.4) |

### 8.2 Default posture — API first

```text
n8n  →  Alveron API  →  Supabase        (default, and the only path used in Phase 1)
n8n  →  Postgres                        (exception — must be explicitly justified, approved and read-only)
```

Direct database access is **not** the default, because the API already enforces authorization, validation, state machines, notifications, audit logging and business rules that raw SQL would bypass.

### 8.3 The one documented exception (and its cost)

`docs/ALVERON_EVENTS.md` §9 explicitly recommends: *"For everything else, drive from the database using the service-role connection (the app itself does): poll on a cadence, using created_at/updated_at watermarks, and treat `order_events`/`admin_logs`/`notifications` rows as the append-only signals."* `docs/ALVERON_DATABASE.md` §7 gives matching read patterns.

That is the **documented architectural reason** for a DB read path. Its costs must be stated plainly:

- The only credential available for that path is the **Supabase service-role key**, which **bypasses RLS entirely** and grants full database authority. A leaked automation key would be equivalent to full production data access.
- The events doc also warns **against external Postgres triggers**, because the application performs multiple sequential writes per operation and triggers could fire spuriously.
- DB polling does not reproduce application-level authorization semantics; it moves trust into this repository's code.

### 8.4 Decision (PROPOSED)

| Stage | Data path | Rationale |
|---|---|---|
| **Stage 1 — first workflow** | **API only.** No database credential of any kind is stored in this repository or in n8n | Proves the integration with the lowest possible risk; uses nothing more than an admin session |
| Stage 2 — only if API polling proves inadequate | Read-only DB observation, **watermark-based**, through a **dedicated read-only Postgres role** created by the Alveron owners (gap **G-3**). If a read-only role is not feasible, the service-role option must be re-approved in writing together with the isolation rules below | Addresses the "no incremental order listing" gap (G-1) without granting full service-role power |
| **Never** | Direct DB **writes**, DB triggers, schema changes | Bypasses business logic and corrupts invariants (notifications, audit, referral/coupon state) |

If Stage 2 is ever approved, the rules are: read-only; a small allow-list of tables/columns; no `SELECT *` on customer-auth tables; the credential lives only in the gateway's secret store (**never** in n8n); every query parameterised and bounded; and every DB-derived action still writes back **through the API**, never through SQL.

### 8.5 Database facts automation must respect

1. **No writes outside the API, ever.** A raw write skips `order_events`, `admin_logs`, customer notifications, inventory RPCs, referral qualification/cancellation and coupon accounting.
2. **Two inventory paths exist** (direct stock decrement inside the payment RPC vs `order_inventory_reservations` used by the admin `paid` transition). Stock reconciliation by automation would be guesswork → out of scope.
3. **Derived/drift-prone fields**: `coupons.used_count` double-counts by design; `products.avg_rating` / `review_count` are refresh-based. Never base automation decisions on them.
4. **Two shipping tables** (`shipping_rates` is active, `state_shipping_rates` is legacy seed) and **two return systems** (`returns` current, `return_requests` legacy).
5. **`payment_status` casing is inconsistent** (`PENDING`/`pending`/`SUCCESS`/`paid`). Treat payment as successful when the value is `SUCCESS` **or** `paid`.
6. **`orders.order_number` is a sequence** (human-facing `#n`), not a stable identifier; correlate on `orders.id` (UUID).

### 8.6 Field-level minimisation (PROPOSED)

| Allowed to enter automation | Never to enter automation |
|---|---|
| `order.id`, `order_number`, `status`, `payment_status`, totals, currency, timestamps | Password hashes, auth tokens, refresh tokens, session data |
| `order.items[]` (title, variant, qty, price) | `auth.users` records; anything from Supabase Auth beyond email / verification state |
| `customer_name`, `customer_email`, `customer_phone` — **only when that customer must be contacted** | Full address dumps or whole-payload copies when name + contact suffice |
| `courier_name`, `tracking_number`, `tracking_url`, `estimated_delivery_date` | `payments.gateway_response` (raw provider payload) — unnecessary for notification logic |
| `referral.status` and amounts **as computed by Alveron** | Recomputed discount/reward values of our own making |

---

## 9. Events

### 9.1 CONFIRMED events (exist today)

Alveron has **no event bus**. "Events" are database state changes produced by HTTP handlers; automation must observe them. The single genuinely *pushed* event is the Paystack webhook.

| # | Event | Produced by | Observable signal | Push to n8n? |
|---|---|---|---|---|
| E1 | Paystack `charge.success` | Paystack → `POST /orders/paystack/webhook` (HMAC-verified) | `payments.status=SUCCESS`, order `payment_status`, `order_events('paid')`, `admin_logs PAYMENT_SUCCESS` | **No** (Alveron-internal) |
| E2 | Order created | `POST /orders` | new `orders` row; `order_events(status='pending', note='Order created')`; `notifyStaff` fan-out; referral attribution where applicable | No |
| E3 | Order becomes paid | Webhook or `POST /orders/paystack/verify` via RPC `confirm_paystack_payment` | `order_events(status='paid')`; `payments→SUCCESS`; `orders.payment_status`; `payment_ref`/`paystack_ref`/`payment_date` | No |
| E4 | Payment anomaly | Same RPC on amount/currency/stock mismatch | `payments.status='VERIFICATION_FAILED'`; order reset to `pending`; `admin_logs PAYMENT_INVENTORY_REVIEW` | No |
| E5 | Order status transitioned | `PATCH /orders/:id/status` (admin) | `order_events(status=X)`; `admin_logs order_status_changed`; `notifications` for the customer; timestamps (`delivered_at`, `cancelled_at`, `refunded_at`); inventory RPCs | No |
| E6 | Order delivered | Same, `delivered` transition | as E5, plus `review_requests(awaiting)` upsert, `delivered_at`, `finalize_order_inventory`, and a `qualifyReferral` attempt that normally early-returns | No |
| E7 | Shipment/tracking recorded | `PATCH /orders/:id/fulfilment` (admin) | `orders.courier_name`/`tracking_number`/`tracking_url`/`estimated_delivery_date`; `admin_logs courier_updated` | No |
| E8 | Return requested | `POST /returns` (customer) | new `returns` row `status='pending'`; `notifyStaff` fan-out; `returns` email path exists | No |
| E9 | Return status changed | `PATCH /admin/returns/:id/status`, `POST /admin/returns/:id/more-info` | `returns.status` transition; customer `notifications`; **customer email via Resend (works)**; timestamp columns | No |
| E10 | Review submitted | `POST /reviews` (auth, verified purchase) | `reviews` row `status='pending'`; `notifyStaff` fan-out; related `review_requests` → `submitted` | No |
| E11 | Review moderated | `PATCH /admin/reviews/:id/status`, `.../featured`, `DELETE /admin/reviews/:id` | `admin_logs review_*`; `products.avg_rating`/`review_count` refresh; reviewer notification on approve/reject | No |
| E12 | Referral qualified / rewarded | `qualifyReferral` → `awardReward`, invoked only from `processPendingReferrals()` (i.e. from `GET /referrals/me/stats` or `GET /referrals/admin/stats`) | `referrals.status` `pending→qualified→rewarded`; `credit_transactions` row (`referral_reward`, `available`, `expires_at`) | No |
| E13 | Referral cancelled | `cancelReferral` on order `cancelled`/`refunded`/`refund_completed`/`return_requested` | `referrals.status='cancelled'` | No |
| E14 | Staff notification fan-out | `notifyStaff` on new order / new return / new review | one `notifications` row per `employees.status='active'` | No |
| E15 | Login activity | `POST /auth/login`, `POST /auth/admin-login` | `login_events` row; `profiles.last_login_at` / `employees.last_login_at` | No |
| E16 | Configuration/administration changes | coupons, settings, employees, roles, customers services | `admin_logs` rows (`settings_updated`, `role_created`, `customer_*`, `employee_*`, …) | No |

> Note on E12: referral rewards effectively **do not happen on time today** because nothing schedules `processPendingReferrals`. That is a real, confirmed business gap that automation can close *without* re-implementing any rule (§14.3).

### 9.2 PROPOSED events (do **not** exist — do not build against them)

`docs/ALVERON_EVENTS.md` §9 contains a proposed catalogue for this project, prefaced by *"Wait, do these exist today? — No."* These are requirements, not capabilities:

| Proposed event | Why it cannot be used today |
|---|---|
| `order.paid` (as a push) | No outbound webhook exists; must be **polled** |
| `order.delivered` (as a push) | No push; poll `orders.status` / `order_events` |
| `shipment.tracking_added` | No push; poll tracking columns |
| `return.requested` | No push; poll `returns.status='pending'` |
| `return.refund_completed` | No push; poll `returns.status` |
| `review.pending` | No push; poll `reviews.status='pending'` |
| `inventory.low_stock` | No push; poll `product_variants.stock` vs `products.low_stock_alert` |
| `referral.qualified` / `referral.rewarded` | No push; cron-trigger the qualification endpoint and poll results |

**Rule:** if a workflow needs an event that does not exist, this repository documents the requirement (gap G-2) instead of inventing a trigger.

### 9.3 Detection map for Stage 1 (API-only polling) — PROPOSED

| Business need | Detection (API-first) | Idempotency key |
|---|---|---|
| New paid order | Poll `GET /orders` (admin) on a cadence; keep rows where `payment_status ∈ {SUCCESS, paid}`. The response already embeds `payments[]` | `order.id` + `paid` (secondary: `payments[].provider_reference`) |
| Payment anomaly (needs a human) | Same poll; `payment_status='VERIFICATION_FAILED'` | `order.id` + `verification_failed` |
| Tracking added / shipped | Same poll; `tracking_number` populated and/or `status ∈ {shipped, in_transit}` | `order.id` + `tracking_number` |
| Delivered | Same poll; `status='delivered'` (also expect `delivered_at`) | `order.id` + `delivered` |
| Cancelled / refunded | Same poll; `status ∈ {cancelled, refunded, refund_completed}` | `order.id` + status |
| Return requested / return updated | Poll `GET /admin/returns` (admin) and watch `status` transitions | `return.id` + `status` |
| Review awaiting moderation | Poll `GET /admin/reviews?status=pending` | `review.id` + `pending` |
| Referral qualification due | Cron → `POST /alveron/referrals/process` (invokes `GET /referrals/me/stats`), then read `GET /referrals/admin/all` | `referral.id` + `status` |
| Low stock | Poll `GET /products` and, if variants are not included, `GET /products/:id` per product — **cost/coverage unverified, see §16.6** | `variant.id` + threshold bucket |
| Abandoned cart | **Not possible today** — no cart listing endpoint (gap **G-5**) | — |

**Cost warning (PROPOSED):** because `GET /orders` returns the entire order history with items and payments, every poll grows with store volume. This is acceptable for a first workflow at current volume but must be replaced by gap **G-1** (incremental listing) before order counts make polls expensive or slow.

---

## 10. Security

### 10.1 Credential handling — rules

1. **No credential is ever committed**: not in workflow JSON, source, `.env` files in git, docs, screenshots or logs.
2. **Secrets are injected at runtime**: environment variables / Docker or Kubernetes secrets (n8n supports the `_FILE` suffix pattern; the gateway reads its own env). A `.env.example` lists **names only**.
3. **One holder per secret.** Only the gateway holds Alveron credentials. Only the gateway holds the Supabase publishable key for refresh. Only Alveron holds `PAYSTACK_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
4. **n8n holds only**: the gateway API key (an n8n credential) and outbound provider credentials (email/Slack/etc.), each as an n8n credential with the narrowest scope available.
5. **Rotation is a designed-for event**: rotating the service-account password, gateway key or provider key must not require editing workflows. Document the rotation procedure in `docs/` when the gateway is built.
6. **Never pass secrets via expressions.** n8n persists node inputs/outputs in execution data; a token pasted into a header expression can therefore be retained. Credential fields configured as n8n credentials are not part of the workflow JSON and are the correct mechanism. Combined with `EXECUTIONS_DATA_PRUNE*` settings, this keeps tokens out of the execution history.

### 10.2 Where each secret lives (PROPOSED)

| Secret | Lives in | Never in |
|---|---|---|
| Alveron service-account email/password | Gateway secret store (env/secret manager) | n8n, git, docs, workflow JSON |
| Supabase publishable/anon key (refresh only) | Gateway secret store | n8n, git |
| Supabase **service-role** key | Alveron's own `.env` only | **This repository, n8n, anywhere else** |
| `PAYSTACK_SECRET_KEY` | Alveron's `.env` only | This repository, n8n |
| Gateway API key | n8n credential + gateway env | workflow JSON, git |
| Email/Slack/etc. provider keys | n8n credentials | workflow JSON, git |
| `N8N_ENCRYPTION_KEY` | n8n instance secret (all workers identical) | git; losing it makes stored credentials undecryptable |

### 10.3 Securing the automation system itself

- **n8n is not internet-facing for Alveron traffic.** It should sit behind its own hostname/TLS with user registration disabled, owner-account MFA enabled (`N8N_MFA_ENFORCED_ENABLED`), and `n8n audit` run periodically.
- **The gateway is private**: bound to localhost/private network, reachable only by n8n, authenticated with `GATEWAY_API_KEY`; not published to the internet.
- **No anonymous access** to either component; least-privilege OS/service users; no shared admin accounts for automation.
- **Auto-deactivation awareness**: `N8N_WORKFLOW_AUTODEACTIVATION_ENABLED` can silently unpublish repeatedly crashing workflows; if enabled, alert on deactivation (otherwise automation stops and nobody notices).

### 10.4 Authorization of automation actions

| Class | Examples | Control |
|---|---|---|
| **Read** | orders, returns, referrals, reviews, stats | Allowed freely (audited) |
| **Notify** | customer email, admin alert | Allowed; content limited to what the workflow needs |
| **Write (Alveron)** | `PATCH /orders/:id/status`, `.../fulfilment` | **Disabled by default** (`FEATURE_ENABLE_ALVERON_WRITES=false`); one explicit workflow per action; validated inputs; human-initiated or strictly validated condition |
| **Destructive** | refunds, cancellations, customer/employee changes, deletes | **Out of scope for automation.** Performed by humans in the Alveron admin UI |

### 10.5 Sensitive customer data

- Minimum necessary fields only (§8.6). Retrieval is justified per workflow, not "because it is available".
- Do **not** copy customer data into n8n data tables (they are small, project-visible, and not a system of record); store only opaque identifiers/keys.
- Do **not** log full payloads, addresses, phone numbers or full order bodies. Log identifiers + outcome + reason.
- Apply execution-data retention limits so PII does not accumulate in n8n history.
- Deleting/exporting customer data remains an Alveron responsibility; automation must not create a shadow customer database.

### 10.6 Payment data

- Automation **never** sees card data: Paystack collects it, and Alveron stores only provider references/amounts/status.
- No Paystack secret, no Paystack API calls, no second payment consumer (§6.2).
- Treat `payments.gateway_response` as off-limits for automation (raw provider payload, unnecessary).
- Never recompute amounts; Alveron's RPC already enforces `amount = orders.total × 100`.

### 10.7 AI-specific restrictions (PROPOSED)

1. An AI step must **never** invent order, payment, referral, refund or stock information. It may only state facts returned by the gateway for that specific customer/resource.
2. AI output is **advisory**: it may classify, draft and route. It may **not** directly trigger writes to Alveron. The pattern is: AI → structured proposal → validation against a strict schema/allow-list → **deterministic workflow** → gateway → (only if the write path is enabled and justified) Alveron.
3. Customer-originated text is untrusted input: treat it as data, never as instructions (prompt-injection). The AI must not be able to escalate its own permissions, call admin endpoints, or move money.
4. No credentials or secrets are ever placed in a model prompt; no customer PII is sent to a third-party model without an explicit, documented decision.
5. Every AI-assisted path must be able to answer "which Alveron resource did this come from?" — otherwise it must refuse to answer the customer.

---

## 11. Idempotency

### 11.1 Principle

Polling plus retries means **at-least-once** processing, so every automation action must be safe to execute more than once. There are two distinct layers, and they must not be confused:

1. **Alveron-side idempotency (already exists — rely on it, never re-implement it):**
   - `confirm_paystack_payment` returns `{confirmed:true, idempotent:true}` when the payment is already `SUCCESS`.
   - `awardReward` checks for an existing `referral_reward` transaction **and** is protected by a partial unique index on `credit_transactions.referral_id`.
   - Order status transitions are validated against a strict map (a repeated transition fails with 400).
2. **Automation-side dedupe** for actions *outside* Alveron: notifications, alerts, follow-ups, and any future write.

### 11.2 Dedupe ledger — PROPOSED

**Preferred implementation: an n8n Data table** (e.g. `alveron_event_ledger`), used through the Data Table node (`Get row` / `Upsert row`), because data tables cannot be read from a Code node or expression.

| Column | Purpose |
|---|---|
| `dedupe_key` | Deterministic key (§11.3) |
| `workflow` | Which workflow owns the key |
| `resource_type` / `resource_id` | e.g. `order` / UUID |
| `status` | `claimed` → `processed` (or `failed`) |
| `attempts` | Retry counter (capped) |
| `first_seen_at`, `processed_at` | Timestamps for retention and debugging |
| `last_error` | **Short, redacted** reason string only |

Flow: derive key → `Get row` → if already `processed`, **stop** (log "duplicate skipped") → else `Upsert` as `claimed` → perform the action → `Upsert` as `processed`. If a run dies between claim and completion, the next run sees a stale `claimed` row and may retry up to the attempt cap.

**Known limitation (stated honestly):** n8n data tables are not transactional across nodes, so the claim/complete pair is best-effort; two concurrent executions could in principle claim the same key. Mitigations: keep polling workflows single-concurrency, and make the sink tolerant (a duplicate notification email is acceptable; a duplicate *Alveron write* is not — another reason writes stay gated and rare).

**Alternative (PROPOSED, stronger):** let the **gateway** own the ledger in a real store and expose `POST /claims` + `POST /completions`. That gives atomicity and keeps state out of n8n. Decide at implementation time; the trade-off is one more component versus stronger guarantees.

### 11.3 Key derivation — PROPOSED

| Action | Dedupe key |
|---|---|
| Customer confirmation for a paid order | `order:{order_id}:paid:notify-customer` |
| Admin alert for a paid order | `order:{order_id}:paid:notify-admin` |
| Stock/payment anomaly alert | `order:{order_id}:verification_failed:notify-admin` |
| Tracking/shipped notification | `order:{order_id}:tracking:{tracking_number}` |
| Delivered follow-up | `order:{order_id}:delivered:notify` |
| Cancellation/refund alert | `order:{order_id}:{status}:notify-admin` |
| Return update alert | `return:{return_id}:{status}` |
| Review moderation alert | `review:{review_id}:pending` |
| Referral reward notification | `referral:{referral_id}:{status}` |

Rules: a key must contain a **stable identity plus the event/version** — never mutable state alone (never bare "status=paid" without the order id) and never a timestamp.

### 11.4 Idempotency of outbound notifications

- Email/Slack sends are not natively idempotent. The ledger prevents most duplicates; where the provider supports it, also send a deterministic reference/idempotency header.
- Prefer one notification per business event, not per poll cycle: the ledger is what turns "poll every 5 minutes" into "notify exactly once".

### 11.5 Retention

Ledger rows should be pruned (PROPOSED: 90 days) to respect the default 200 MiB data-table budget. Pruning must never remove a key still inside a plausible replay window.

---

## 12. Error handling

### 12.1 Layers

```text
node Retry on Fail (immediate, bounded)
        ↓ still failing
workflow-level retry with explicit backoff (Wait node / computed delay)
        ↓ still failing
error workflow (Error Trigger) → normalise → redact → dedupe → log → alert admin
        ↓
ledger row marked 'failed' → manual intervention (runbook)
```

### 12.2 Retry policy — PROPOSED

| Class (from §7.7) | Retry? | Policy |
|---|---|---|
| Transport (timeout/DNS/TLS), 5xx, 429 | Yes | 3–4 attempts; base 2 s; exponential ×2; cap ≈ 60 s; small jitter; honour `Retry-After` on 429 |
| 401 | Once | Gateway refreshes the token, then a single retry |
| 400 / 403 / 404 / invalid transition | **No** | Terminal — log + alert; indicates a bug or a permission gap, not transience |
| Schema mismatch | **No** | Fail closed + alert |
| Duplicate/dedupe hit | n/a | Not an error: log "duplicate skipped" and finish green |

n8n's node-level Retry on Fail provides only `Max Tries` + a **fixed** `Wait Between Tries (ms)`. Genuine backoff must be explicit (a loop whose Wait delay is computed from the attempt number). PROPOSED for Phase 7/11.

### 12.3 Retry × idempotency

Retrying is only safe because every action carries a dedupe key (§11.3) and Alveron's own mutations are idempotent. A retry must **never** be able to cause a second Alveron-side effect.

### 12.4 Error workflow — PROPOSED design

The Error Trigger receives `{execution:{id,url,retryOf,error:{message,stack},lastNodeExecuted,mode},workflow:{id,name}}`. Design:

1. **Normalise** into a compact record: workflow name/id, execution id/url, failing node, truncated error message, and the **business context the workflow must attach explicitly** (e.g. `order_id`, `dedupe_key`) — the error payload alone may not contain it.
2. **Redact** before sending anywhere: no tokens, no full payloads, no addresses or phone numbers.
3. **Alert-storm control**: hash a signature (workflow + failing node + error code) and suppress repeats inside a window (e.g. 15 min), reporting a count instead. A broken integration must not send hundreds of emails a day.
4. **Notify** the admin channel; where a customer-facing action failed, record the ledger row as `failed` for later replay.
5. **Never** blindly "retry the whole workflow" from the error workflow when the failure was terminal.

### 12.5 Required failure behaviours

| Situation | Required behaviour |
|---|---|
| Alveron API unavailable | Retry per policy → then log + alert. **Do not** mark processed. Never mutate local state to compensate |
| Invalid event / unparseable response | Reject safely; log a specific reason; **no side effects**; alert if it recurs |
| Duplicate event | Detect via ledger; never execute twice; log at low severity |
| Partial success (sent, ledger not updated) | Ledger written before *and* after; sink is duplicate-tolerant; alert only on recurrence |
| 403 / guard failure | Terminal + alert — usually gap G-4 manifesting; a human must fix the account or the contract |

### 12.6 Never allowed

- Silent `catch` blocks that swallow errors — the exact flaw already present in Alveron's order-email path (§2.3 item 8) must not be repeated here.
- Logging secrets, tokens or unnecessary customer details in error paths.
- Marking work as done when it was not: a "green" run must mean the action really happened.
- Alert storms, or alerts nobody can act on — every alert must name the workflow, the resource and the next action.

## 13. Integration gaps

Each gap is recorded rather than patched: **this repository does not modify Alveron.** Nothing below is implemented without owner approval. Gaps are formatted as: Requirement → Why automation needs it → Current Alveron capability → Gap → Possible implementation → Risk.

### G-1 — No incremental / paginated order listing
- **Requirement:** ability to fetch "orders changed since `<timestamp>`" with pagination.
- **Why automation needs it:** every order-driven workflow depends on discovering new/changed orders cheaply and reliably. Today the only admin list (`GET /orders`) loads the **entire** order set (with items and payments) and filters in Node.
- **Current Alveron capability:** `GET /orders` supports only `status`, `paymentStatus`, `state`, `search` — no `limit`/`offset`, no `since`/watermark, fixed `created_at DESC`.
- **Gap:** polling cost grows with lifetime order volume; latency and the 60 req/min budget become binding long before order volume is large in business terms.
- **Possible implementation (Alveron side):** add `updatedSince`/`createdSince` plus `limit`/`offset` (or a cursor) to the orders list, ideally filtered at the database layer. Small, low-risk change with no business-logic impact.
- **Risk if unaddressed:** polling becomes expensive and slow — a very common cause of integration failure. Interim mitigation: modest cadence, cap concurrency, accept the cost.

### G-2 — No outbound events (webhooks / stream) from Alveron
- **Requirement:** a push channel for at least `order.paid`, `order.status_changed`, `return.requested`, `review.pending`, `referral.rewarded`.
- **Why automation needs it:** push gives low latency, lower cost, fewer missed events and removes most poll-based dedupe complexity. It is the only way to build genuinely reactive workflows (e.g. immediate admin alert on a paid order).
- **Current Alveron capability:** no outbound webhooks, no queue, no scheduler (§2.3). Only the inbound Paystack webhook exists.
- **Gap:** automation must poll; latency is bounded by the poll interval, and "no missed events" rests on watermark correctness rather than delivery guarantees.
- **Possible implementation (Alveron side):** a small outbound dispatcher posting signed (HMAC) JSON events to configured subscriber URLs (n8n) with retry and dead-lettering — idempotent and replay-safe. Alternatively, a provider-neutral queue.
- **Risk if unaddressed:** higher latency and cost, plus pressure to build DB triggers (explicitly discouraged). **Do not** repoint Paystack at n8n as a workaround (§6.2).

### G-3 — No read-only database credential
- **Requirement:** a least-privilege, read-only Postgres role for Stage-2 observation if it is ever needed.
- **Why automation needs it:** the only DB path available today is the service-role key, which bypasses RLS and grants full authority (§8.3) — disproportionate for read-only observation.
- **Current Alveron capability:** service-role key only; RLS exists but that client bypasses it.
- **Gap:** no way to observe DB state with minimal privilege.
- **Possible implementation (Alveron side):** a dedicated `automation_ro` Postgres role with `SELECT` on an allow-listed set of tables — preferably through a small set of views exposing only the needed columns.
- **Risk if unaddressed:** teams resort to the service-role key, turning an automation bug into a full-data-breach vector. Recommendation stands: keep Stage 1 API-only.

### G-4 — No least-privilege service account for admin-scoped endpoints
- **Requirement:** automation should authenticate as a dedicated principal holding **only** what it needs (orders read, returns read, referrals read, staff notifications).
- **Why automation needs it:** least privilege and blast-radius reduction (§10). A leaked automation credential must not be equivalent to a full store admin.
- **Current Alveron capability:** verified guard logic means `@Roles('admin')` endpoints accept only `profiles.role='admin'`, an employee whose RBAC role slug is literally `admin`, or `is_super_admin`. `PermissionsGuard` endpoints work with narrower roles, but the endpoints automation most needs (`GET /orders`, `GET /admin/returns*`, `GET /referrals/admin/*`, `GET /admin/stats`) are `@Roles('admin')`-gated, and `EmployeeGuard` endpoints (staff notifications) additionally require an active employee row.
- **Gap:** the practical service account must be **admin-equivalent** — and, to satisfy all four guards, both a legacy admin profile *and* an employee row. That directly contradicts least privilege.
- **Possible implementation (Alveron side):** accept a dedicated role slug (e.g. `service_automation`) in the relevant `@Roles(...)` decorators, or expose a narrow read-only service surface guarded by that role. Purely additive; no change for existing users.
- **Risk if unaddressed:** automation runs with full admin power, so one leaked secret is a full-store compromise — and the temptation to bypass the API with the service-role key grows.

### G-5 — No abandoned-cart capability
- **Requirement:** identify abandoned carts and contact the customer.
- **Why automation needs it:** it is one of the requested workflow categories.
- **Current Alveron capability:** `carts`/`cart_items` exist (marked *REFERENCED/EXPECTED* in the DB doc), but there is **no API to list carts**, no "abandoned" state, no event, and cart endpoints are unauthenticated with opaque IDs.
- **Gap:** both data access and the business definition are missing (what counts as abandoned? for how long? is there consent for marketing email?).
- **Possible implementation (Alveron side):** define the rule (e.g. `updated_at` older than N hours, no order created, customer identified), expose a paginated view, and settle the consent/opt-in policy before any messaging.
- **Risk if unaddressed:** none to correctness — it is simply out of scope. **Do not** approximate it by scraping carts or querying unconfirmed tables.

### G-6 — Order emails are broken inside Alveron
- **Requirement:** customers must receive order confirmation and order-status emails.
- **Why automation needs it:** this is the highest-value, lowest-risk first workflow — and it currently does not work at all.
- **Current Alveron capability:** `orders.service.ts` requires `src/lib/email-templates`, which **does not exist** in the repository, so both calls throw inside a `try/catch` and only log `Failed to send email notification`. Returns/customer/employee emails via Resend **do** work.
- **Gap:** no order email is delivered today. Automation can legitimately fill this by sending from its own side after detecting a paid order.
- **Possible implementation:** (a) automation-side email (PROPOSED, no Alveron change), or (b) Alveron implements the missing template module.
- **Risk:** **coordination risk** — if Alveron later fixes its email path *and* automation keeps sending, customers receive duplicates. Whichever side owns order email must be recorded, and the automation workflow should be switchable off by configuration.

### G-7 — No health endpoint
- **Requirement:** a cheap liveness/readiness probe for Alveron.
- **Why automation needs it:** to distinguish "Alveron is down" from "our workflow is broken", and to avoid hammering a failing API.
- **Current Alveron capability:** none found (`GET /health`, `/status` do not exist).
- **Gap:** observability. Interim: the gateway's `/health` probes a documented public endpoint (e.g. `GET /products` or `GET /shipping/config`) and reports reachability, treating non-2xx/timeouts as "degraded".
- **Possible implementation (Alveron side):** a trivial `GET /health` returning service + DB connectivity status.
- **Risk if unaddressed:** slower incident diagnosis; alert fatigue from ambiguous failures.

### G-8 … G-14 — Additional gaps (summarised)

| ID | Requirement | Current capability / gap | Possible implementation | Risk if unaddressed |
|---|---|---|---|---|
| **G-8** | Aggregate referral/credit reporting | `CreditService.getAdminCreditStats()` exists but **no controller exposes it**; only per-user endpoints | Expose it behind an existing admin permission | Reporting must be assembled from many per-user calls; credit exposure cannot be monitored centrally |
| **G-9** | WhatsApp / chat customer messaging | `store_settings.whatsapp` is configuration only; **no server-side provider integration** | Choose a provider; host intake in n8n (Webhook node) with templates; define consent | Support workflows limited to email; teams may invent unofficial channels |
| **G-10** | Confirmed production API URL + proxy facts | **No self-described hostname**; the API docs state it is unknown (§7.1) | Confirm hostname/TLS, whether a proxy preserves `rawBody`, and `NODE_ENV` | Automation cannot safely be pointed at production; guessing risks hitting the wrong environment |
| **G-11** | Order state reflecting a return | The returns module **never changes order status** (no `return_requested` transition) | Alveron could transition the order (business decision), or automation treats `returns` as the source of truth | Automation must **never** infer order status from a return; conflating them produces wrong customer messages |
| **G-12** | Creating in-app notifications from outside Alveron | `notifications` is written only by internal services; no endpoint accepts an external notification | Add an internal endpoint, or accept outbound-only channels (email/chat) | No in-app notice from automation — fine, provided it is not assumed |
| **G-13** | Executing refunds | No refund API and **no Paystack refund call**; refunds are only *recorded* (`refunded`, `refund_completed` + amount/method/reference) | A human executes the refund in Paystack; automation records nothing | Automation that "refunds" would mislead customers and the ledger — **explicitly out of scope** |
| **G-14** | Minor: pickup-location writes; product-list variant coverage; newsletter segmentation | No pickup write API; `GET /products` variant inclusion unverified (§16.6); newsletter is subscribe/unsubscribe only | Raise individually if a workflow needs them | Low — simply avoid designing around them |

---

## 14. Domain notes (Alveron-owned behaviour automation must respect)

### 14.1 Order lifecycle

Strict, Alveron-enforced transition map (anything else ⇒ `400 Cannot move order from X to Y`):

```text
pending → cancelled
paid → processing | cancelled | return_requested
processing → packed | cancelled
packed → ready_for_shipment
ready_for_shipment → shipped
shipped → in_transit | delivered
in_transit → delivered
delivered → return_requested
return_requested → under_review
under_review → return_approved | cancelled
return_approved → item_received
item_received → refund_completed
cancelled → refunded
refunded | refund_completed → terminal
```

Side effects that make direct database writes dangerous: timestamps (`payment_date`, `delivered_at`, `cancelled_at`, `refunded_at`), inventory RPCs (`reserve_order_inventory`, `release_order_inventory`, `finalize_order_inventory`), `order_events`, `admin_logs`, customer `notifications`, `review_requests` on delivery, and referral qualification/cancellation.

**Automation stance:** read + notify. Transitions are a human/admin action; if one is ever automated it must be a single explicit, gated workflow with validated inputs (IP-6) — never a side effect of a notification workflow.

### 14.2 Customer lifecycle

| Stage | Alveron behaviour | Automation stance |
|---|---|---|
| Registration | Supabase Auth signup (password ≥ 8 chars, upper + lower + digit) | Out of scope — no reason to create accounts |
| Login / verification | `login_events`, `profiles.last_login_at`; blocked / suspended / deleted statuses rejected at login | Read login activity for reporting only; never create or modify accounts |
| Profile status change | Admin-driven (`POST /admin/customers/:id/status`), sends email via Resend | **Never automate.** Blocking or suspending a customer is a human decision |
| Password reset / verification resend | Admin endpoints send email | Out of scope |
| Retention / deletion | Not implemented in Alveron | Automation must not become a de-facto customer store (§10.5) |

### 14.3 Referrals and Alveron Credit — the clearest "coordinate, don't duplicate" case

**Business rules verified in source (`referrals.service.ts`, `referral-rules.ts`, migration 016):**

| Setting (defaults, stored in `store_settings.referral_program`) | Value |
|---|---|
| `customer_discount` (referred customer's first-order discount) | 2,000 |
| `min_qualifying_order` (minimum product subtotal to qualify) | ₦30,000 |
| `referrer_reward` | ₦1,000 |
| `credit_min_subtotal` (subtotal needed to redeem credit) | ₦20,000 |
| `credit_max_per_order` | ₦2,000 |
| `credit_expiry_days` | 90 |
| `return_window_days` (must elapse after delivery before qualification) | 2 |

Additional rules: self-referral blocked; one referral per referred user (unique partial index); discount only for a first qualifying order; discount capped at subtotal; referral discount and coupon are **mutually exclusive**; credit redemption is capped/FIFO and evaluated **at read time** for expiry.

**Qualification flow:** referral `pending` (attached at order creation) → order `delivered` **and** payment `SUCCESS`/`paid` **and** `delivered_at + return_window_days ≤ now` → `qualified` → `rewarded` (a `credit_transactions` row `type='referral_reward'`, `status='available'`, `expires_at = now + credit_expiry_days`, idempotent via app check + unique index). Cancellation on `cancelled`/`refunded`/`refund_completed`/`return_requested`.

**The confirmed problem:** `processPendingReferrals()` has **no scheduler** — it runs only when someone hits `GET /referrals/me/stats` or `GET /referrals/admin/stats`. So rewards are granted late or not at all.

**Automation stance (do / don't):**

- ✅ **DO** schedule a call that triggers Alveron's own qualification (IP-3 / `GET /referrals/me/stats`).
- ✅ **DO** notify the referrer *after reading* the resulting `referrals.status`/`credit_transactions` state from Alveron.
- ❌ **DON'T** compute discounts, rewards, eligibility, thresholds or expiry anywhere in n8n.
- ❌ **DON'T** write `credit_transactions` or `referrals` rows, and don't "fix" expired credit.
- ❌ **DON'T** treat automation's own record of a reward as authoritative — Alveron's ledger is.

### 14.4 Returns

- Current flow lives in `returns` (`return_requests` is legacy — ignore it).
- Return window: **48 h from `orders.delivered_at`** (`RETURN_WINDOW_MS`); eligibility codes `NOT_DELIVERED` / `ALREADY_REQUESTED` / `EXPIRED`.
- Status machine: `pending → under_review|approved|rejected`; `under_review → approved|rejected`; `approved → item_received|refund_completed`; `item_received → refund_completed`; `rejected` and `refund_completed` terminal. `refund_completed` requires an integer `refundAmount`, a `refundMethod` and a `refundReference`; `rejected` requires an admin note.
- Alveron already sends the customer a **working** email on each transition (Resend) plus a customer `notifications` row, and fans out staff notifications on submission.
- **Automation stance:** read + internal escalation only. Do **not** transition return statuses (admin-only, and duplicates Alveron's own emails), do **not** attempt refunds (G-13), do **not** conclude anything about order status from a return (G-11).

### 14.5 Shipping

- Public: `GET /shipping/config` (settings + active rates, 5-minute in-memory cache), `POST /shipping/quote` (`{state, subtotal}` → fee/free-shipping flag/ETA), `GET /shipping/reverse-geocode` (Nominatim; may return `null`).
- Admin: settings + per-state/city rate CRUD. `shipping_rates` is authoritative; `state_shipping_rates` is legacy seed data.
- Tracking lives on the order (`PATCH /orders/:id/fulfilment`) — `courier_name`, `tracking_number`, `tracking_url`, `estimated_delivery_date`.
- **Automation stance:** read quotes/config for notifications ("free shipping over X"), notify customers when tracking appears, alert admins about unfulfilled paid orders. Never write rates (admin-only, out of scope).

### 14.6 Admin operations

| Operation | Access | Automation stance |
|---|---|---|
| `GET /admin/stats`, `GET /admin/analytics`, `GET /admin/audit-logs` | Admin / Admin·perm | ✅ Read for scheduled reporting and digest emails |
| `GET /admin/notifications` | Employee | ✅ Read staff to-dos (requires the employee row — §5.4) |
| `PATCH /reviews/:id/status`, `/featured` | Admin·perm | ⚠️ Optional later; notify admins instead |
| Customers/employees/roles/coupons/shipping writes | Admin / Admin·perm | ❌ Out of scope. Human actions |
| `PATCH /admin/users/:id/role` | Admin | ❌ **Never.** Privilege changes must not be automated |

---

## 15. Operation classification for automation

Even though the automation service account will be admin-capable (§5.4), automation should only ever call the subset it genuinely needs. Least privilege is enforced **by discipline in this repository** until gap G-4 is fixed.

### 15.1 SAFE FOR AUTOMATION (public, read-only, idempotent-safe)

`GET /products`, `GET /products/handle/:handle`, `GET /products/intro`, `GET /products/category/:slug`, `GET /products/:id`, `GET /categories`, `GET /categories/:slug`, `GET /shipping/config`, `POST /shipping/quote`, `GET /shipping/reverse-geocode`, `GET /coupons/validate`, `POST /referrals/validate`, `GET /referrals/settings`, `GET /settings/store`, `GET /pickup-locations`, `GET /showroom*`, `GET /announcements/active`, `GET /banners`, `GET /reviews/product/:id`, `GET /reviews/photo-gallery/:productId`, `GET /reviews/summary/:productId`, `POST /newsletter/subscribe|unsubscribe`.
**Note:** `POST /support/tickets` is technically public, but creating tickets on a customer's behalf is a business decision, not a technique.

### 15.2 REQUIRES AUTHENTICATION (customer-scoped)

`GET /auth/me`, `PATCH /auth/profile`, wishlist endpoints, `POST /orders/checkout/quote`, `GET /orders/:id` (owner or staff), `GET /orders/:id/events`, `GET /orders/user/:userId` (self only), returns endpoints (`eligibility`, `mine`, `order/:orderId`, `POST /returns`, `POST /returns/upload`), reviews (`eligibility`, `photo`, `POST /reviews`, `DELETE /reviews/:id`), `GET /referrals/me`, `GET /referrals/me/stats`, `GET /credits/me/*`.
**Automation note:** these are **customer** operations. Automation must not impersonate customers — except in the one documented, sanctioned case: `GET /referrals/me/stats` used purely to trigger Alveron's global referral qualification (IP-3).

### 15.3 ADMIN ONLY

`GET /orders`, `GET /orders/session/:sessionId`, `PATCH /orders/:id/status`, `PATCH /orders/:id/fulfilment`, `/admin/stats`, `/admin/analytics`, `/admin/users`, `/admin/users/:id/role`, `/admin/returns*`, `/referrals/admin/*`, `/admin/coupons*`, `/admin/notifications*` (EmployeeGuard), announcements/banners/pickup/showroom writes, `POST /upload`, `DELETE /upload/:path`.

### 15.4 ADMIN ONLY · PERMISSION-GATED

`/admin/customers*` (`customers:view|update`), `/admin/employees*` (`employees:*`), `/admin/roles`, `/admin/permissions` (`roles:*`), `/admin/reviews*` (`reviews:view|approve|update|delete`), `/admin/audit-logs*` (`system_logs:view`).

### 15.5 SHOULD NOT BE AUTOMATED DIRECTLY

| Endpoint / area | Why |
|---|---|
| `POST /orders`, `POST /orders/paystack/initialize`, `POST /orders/paystack/checkout`, `POST /orders/paystack/verify` | Create real orders and contact Paystack; heavy side effects. Documentation explicitly warns against using them for tests |
| `POST /orders/paystack/webhook` | Internal-only; must be reached **only** by Paystack |
| Cart endpoints | **No auth guard at all**; opaque IDs are not identity. Never treat a cart ID as proof of anything, and never use cart endpoints as a customer-data channel |
| `GET /support/tickets`, `GET /support/tickets/:id`, `POST /support/tickets/:id/reply`, `GET /support/returns` | Owner-unsafe in source (any caller can read another user's data). Automation must never use them as a staff conduit |
| `POST /support/returns`, `PATCH /support/returns/:id/status` | Legacy return flow — superseded by the `returns` module |
| `PATCH /admin/users/:id/role`, `/admin/employees/*`, `/admin/roles*` | Privilege and identity management |
| `POST /admin/customers/:id/status`, reset-password, resend-verification | Customer lifecycle decisions: human-only |
| All refunds / `refund_completed` transitions | Money movement; no API support and a human decision (G-13) |
| `POST /reviews` | Requires the customer's own verified purchase |
| Legacy `return_requests` status updates | Wrong system |

---

## 16. Inconsistencies and uncertainties

### 16.1 Documentation vs source — CORS (verified discrepancy)
`docs/ALVERON_API.md` states CORS origin = `FRONTEND_URL || http://localhost:3000`. The source (`main.ts`) instead **hardcodes** `['https://alveronfashion.com', 'https://www.alveronfashion.com']`. Impact: browser clients from any other origin are rejected; server-to-server automation is unaffected (no `Origin` header). Environment: **UNKNOWN** whether this differs by deployment.

### 16.2 Documentation vs source — `staff` and `@Roles('admin')`
The docs describe admin controllers as `Roles('admin')` for "admin (or staff)". Verified source behaviour: `staff` only passes when the decorator's required list *contains* `'staff'`. With `@Roles('admin')`, a user passes only via `profiles.role='admin'`, an employee RBAC slug equal to `admin`, or `is_super_admin`. Practical consequence: **an operations manager employee cannot call `GET /orders`.** Verified; matters for the service account (G-4).

### 16.3 Source-internal inconsistency — employee admin vs `profiles.role`
`getOrderForUser` and `getOrderEvents` re-check `profiles.role` (`admin`/`staff`) directly. An RBAC-admin employee with `profiles.role='customer'` can call `GET /orders` (guard-based) but is **denied** `GET /orders/:id` (service-level check). Verified inconsistency. Mitigation: make the service account a legacy `profiles.role='admin'` as recommended in §5.4.

### 16.4 `payment_status` casing and defaults
Created as `'PENDING'` (011) while the default is `'pending'` (009); success is written as `'SUCCESS'` by the RPC or `'paid'` by the admin transition. Documented and verified. Automation must match case-insensitively against a set.

### 16.5 Payments search by email appears broken
`getAllOrders` search interpolates `${order.email}` — but `orders` has **no `email` column** (it is `customer_email`, plus `shipping_address.full_name/phone`). Verified: email-based search likely never matches. Do not rely on `GET /orders?search=<email>`; filter locally instead.

### 16.6 UNKNOWN — variant coverage of `GET /products`
Whether the public product list includes full variant/stock data was not verified in this pass. Low-stock automation (which needs `product_variants.stock` per variant) therefore has **unverified feasibility**; it may require per-product detail calls, multiplying request cost.

### 16.7 UNKNOWN — environment and deployment facts
To confirm before any production use: the real public API hostname; whether a reverse proxy preserves `rawBody` for the Paystack webhook; whether `NODE_ENV=production` (activates webhook IP allow-listing); whether `PAYSTACK_SECRET_KEY`/`RESEND_API_KEY`/`APP_URL` are set in production; whether anything external already triggers `processPendingReferrals`.

### 16.8 UNKNOWN — live existence of `REFERENCED/EXPECTED` tables
`carts`, `cart_items`, `wishlist_items`, `addresses` are flagged in the database doc as referenced-but-not-guaranteed by migrations. Automation must not depend on them (this is also why G-5 is a hard blocker for abandoned-cart work).

### 16.9 Documented, not re-verified — derived-field drift
Coupon `used_count` double-counts by design; `products.avg_rating`/`review_count` are refresh-based. Automation must not treat them as authoritative.

### 16.10 Documented and verified — duplicated subsystems
Two return systems, two shipping tables, two inventory paths. Automation must pick the current ones: `returns` (not `return_requests`), `shipping_rates` (not `state_shipping_rates`), and never reconcile inventory itself.

### 16.11 n8n-side uncertainty
- **Exponential backoff**: the official HTTP Request documentation documents only a fixed wait between retries → backoff is implemented explicitly here (§12.2), not assumed.
- **Claim/completion atomicity** of Data tables: no cross-node transaction is documented (§11.2) → mitigation is single-concurrency polling plus duplicate-tolerant sinks.
- **Edition gating**: features such as multi-main setup require a licence; verify each capability against the edition actually deployed (community) before relying on it.

---

## 17. Recommended first end-to-end workflow

### 17.1 Selection

**Workflow 1: "Paid Order — Customer Confirmation & Admin Alert".**

Scored against the selection criteria in the brief:

| Criterion | Assessment |
|---|---|
| Confirmed Alveron capability | ✅ `GET /orders` (admin) returns orders **with embedded `payments[]`**, plus `GET /orders/:id` for detail |
| Confirmed event/API | ✅ Payment confirmation is fully owned by Alveron (Paystack webhook + RPC); automation only **observes state** |
| Low risk | ✅ **Read-only against Alveron** — no writes, no Paystack involvement, no order creation |
| Easy testing | ✅ A real dev order can be driven to `paid` through Alveron's real code path and observed end-to-end |
| Useful business outcome | ✅ **The highest-value gap available:** Alveron sends **no order email at all** (§2.3 item 8), so customers currently receive no confirmation |

Rejected first candidates and why:

| Candidate | Why not first |
|---|---|
| Referral reward coordination | Excellent *second* workflow (IP-3); its notification value is lower than a missing order confirmation |
| Returns notification workflow | Returns already send a working customer email — duplication would blur ownership |
| Shipping/tracking notification | Depends on admin `PATCH /fulfilment` discipline; better as workflow 3 |
| Abandoned cart | **Impossible today** (G-5): no API, no "abandoned" concept, no consent policy |
| Customer support triage | No inbound channel exists yet (G-9); needs a channel decision first |
| Any workflow that writes to Alveron | Deliberately deferred until the read path is proven and G-4 is settled |

### 17.2 What it does

```text
Schedule Trigger (every 5 min, configurable)
   ↓
Gateway: GET /alveron/orders            → normalise + schema-validate
   ↓
Filter: payment_status ∈ {SUCCESS, paid}
   ↓
Ledger: fetch key order:{id}:paid:notify-customer   (skip if already processed)
   ↓
Claim key (status=claimed)
   ↓
Gateway: GET /alveron/orders/:id        → items + payments + customer contact
   ↓
Validate: customer_email + items + totals present   (else fail closed + alert)
   ↓
Send customer confirmation email        (n8n email credential)
   + Send admin alert (paid order)      (admin channel)
   ↓
Mark ledger processed   ↓   log outcome (order id, keys, result)
```

### 17.3 Explicitly **out of scope** for workflow 1

Creating orders · initialising or verifying payments · calling Paystack · changing order status · changing tracking · referrals/credit/coupons · any direct database access · any AI step.

### 17.4 Technical requirements

| Requirement | Detail |
|---|---|
| **Trigger** | Schedule Trigger, 5-minute interval (configurable). Rationale: Alveron has no outbound events (G-2) |
| **Alveron API** | `GET /api/orders` (admin session) and `GET /api/orders/:id` |
| **Auth** | Gateway service account (§5.4); the gateway caches/refreshes the Supabase session, n8n uses only the gateway API key |
| **Rate limits** | 1 list call per poll + 1 detail call per new order, serialised — far below 60/min. n8n Batching: `Items per Batch=1`, `Batch Interval ≥ 1000 ms` |
| **Idempotency** | Ledger keys `order:{id}:paid:notify-customer` and `order:{id}:paid:notify-admin` (§11.3). Alveron's own payment idempotency prevents any re-confirmation |
| **Validation** | Require `id`, `order_number`, a successful `payment_status`, ≥ 1 item, and a usable `customer_email` **before** sending. Missing data ⇒ **fail closed** + admin alert — never a guessed recipient |
| **Customer content** | Order number, items (title/variant/qty/price), subtotal/discount/shipping/total in NGN, fulfilment (shipping vs pickup + pickup location), expected timeline, support contact — sourced **only** from Alveron's response. Template must be reviewed by the business |
| **Admin alert content** | Order number, total, item count, payment reference, timestamp, deep link to the Alveron admin order view |
| **Sender** | A production-ready sender/domain must be chosen (deliverability, SPF/DKIM). **UNKNOWN today** — blocking for customer email, not for internal alerts |
| **Failure handling** | Node retry (bounded) → explicit backoff → Error Trigger workflow: redact → dedupe (15-min window) → alert → ledger `failed` (§12) |
| **Observability** | Per run: trigger reason, order ids processed, dedupe skips, keys claimed/completed, notification outcomes, upstream status, retry count, duration. Logs carry ids and outcomes — **never** tokens, addresses or full payloads |
| **Secrets** | Gateway env (service account, base URL) + n8n credentials (gateway key, email provider). Nothing in workflow JSON |
| **Kill switch** | One config flag pauses customer sends while detection/alerting continue |

### 17.5 Test plan — real data, no mocks

Constraints honoured: no mock data, no fake webhooks, no hardcoded customer/order, no simulated responses.

1. **Environment:** run Alveron locally — API on `:4000` (`apps/api`), storefront on `:3000` (`apps/web`) — against the configured **development** Supabase project. Set `ALVERON_API_BASE_URL=http://localhost:4000/api`.
2. **Create real data (either method uses real Alveron code paths):**
   - *Preferred:* place a genuine order through the storefront and pay with a Paystack **test** key, so Alveron's real webhook/verify path confirms it; **or**
   - *Fallback:* on a development order, perform Alveron's own admin transition to `paid` (`PATCH /orders/:id/status` through the Alveron admin UI) so `order_events`, `payment_status` and `admin_logs` are written by real Alveron code.
3. **Run the workflow** against local Alveron, with customer email pointed at a controlled test mailbox.
4. **Prove each property:**
   - the workflow discovers the paid order **without** being told which order it is;
   - the customer email contains only Alveron-sourced facts (spot-check amounts against `GET /orders/:id`);
   - a second run **sends nothing** (ledger skip) — explicit duplicate-suppression evidence;
   - stopping the Alveron API causes bounded retries then a failure alert, leaving the ledger **unprocessed**, and the same order is handled correctly on the next successful run;
   - an order lacking `customer_email` fails closed with an admin alert and **no** message sent.
5. **Evidence to capture:** n8n execution list, ledger rows (`claimed`/`processed`), received emails, admin alerts, and the gateway request log (identifiers only).

**Honest limitation:** this validates the **development** environment. Production validation requires production credentials, a confirmed base URL and the sender decision — all listed as approval items in §19.

---

## 18. Proposed repository structure

### 18.1 Naming / location — needs confirmation

- The brief names the repository **`alveron-automation`**. This machine's working directory is **`C:\dev\alveron_n8n`**, which today contains **only** `docs/` and is **not** a git repository (verified: no `.git`).
- Proposal: treat `C:\dev\alveron_n8n` as the local checkout of `alveron-automation` (or rename the folder and add a remote — an owner decision). No rename, no `git init` and no remote is performed during this analysis phase.

### 18.2 Structure — PROPOSED

```text
alveron-automation/
├── docs/
│   ├── ALVERON_API.md              # read-only copies of the Alveron contract
│   ├── ALVERON_DATABASE.md
│   ├── ALVERON_EVENTS.md
│   ├── INTEGRATION_ANALYSIS.md     # this document
│   ├── GAPS.md                     # later: §13 exported for the Alveron owners
│   ├── SECURITY.md                 # later: secret inventory + rotation procedure
│   └── RUNBOOK.md                  # later: incident + replay procedures
├── src/
│   ├── integrations/
│   │   └── alveron/
│   │       ├── config.ts           # env parsing; fail fast on missing/invalid config
│   │       ├── auth.ts             # service-account login, token cache, single-flight refresh
│   │       ├── http.ts             # fetch wrapper: timeouts, retry + backoff, 429 handling, rate limiting
│   │       ├── client.ts           # one typed method per allowed Alveron endpoint
│   │       ├── schemas.ts          # response validation (fail closed)
│   │       ├── errors.ts           # shared error taxonomy (§7.7)
│   │       ├── logger.ts           # structured, redacting logger
│   │       └── index.ts            # the only public surface of the integration layer
│   ├── gateway/
│   │   ├── server.ts               # HTTP surface for n8n (§7.8)
│   │   ├── routes/                 # read routes; write routes behind the feature flag
│   │   └── middleware/             # GATEWAY_API_KEY auth, request ids, access logging
│   └── ledger/                     # claim/complete abstraction (storage-agnostic)
├── tests/
│   ├── unit/                       # pure logic (retry, keys, validation) via node:test
│   └── contract/                   # run against a live dev Alveron API
├── n8n/
│   ├── workflows/                  # exported workflow JSON — the git source of truth
│   ├── templates/                  # importable skeletons for new workflows
│   └── data-tables/                # ledger table definition (schema as code)
├── scripts/
│   ├── export-workflows.mjs        # wraps: n8n export:workflow --all --separate --pretty --output=…
│   ├── import-workflows.mjs        # wraps: n8n import:workflow --separate --input=…
│   ├── check-alveron-connectivity.mjs
│   └── verify-env.mjs              # validates required env names (never prints values)
├── .env.example                    # NAMES ONLY
├── package.json
└── README.md
```

### 18.3 Conventions this structure enforces

- **One integration layer.** Workflows never contain raw Alveron URLs, tokens or payload shapes; they call the gateway.
- **Workflows are versioned artefacts.** JSON lives in `n8n/workflows/`, exported and imported by script (`--separate --pretty` for readable diffs). Import defaults to deactivated (`--activeState=false`), so a sync can never silently switch production on.
- **Templates over copy-paste**, to prevent divergent copies of the same logic.
- **Tests ship with the code**, using the Node-native test runner (consistent with Alveron's own approach for pure rule modules).
- **`.env.example` lists names only**; `.env` is git-ignored from the first commit.
- **No code here targets Alveron's database** — that dependency direction is enforced by having no database client in the project.

---

## 19. What must be confirmed before implementation

### 19.1 Blocking decisions (needed to start Phase 4/5)

| # | Question | Why it blocks | Suggested default |
|---|---|---|---|
| Q1 | May Phase 1 run **dev-only** (`http://localhost:4000/api`), deferring the production URL question? | The production base URL is **UNKNOWN** (G-10) — without this decision there is nothing to point at | Yes — dev-only for workflow 1 |
| Q2 | Who creates the automation **service account**, and where is its password stored? | Nothing can authenticate without it (§5.4) | Alveron owner creates a dedicated user: `profiles.role='admin'` + active `employees` row with RBAC role slug `admin`; password in the gateway secret store |
| Q3 | Is the **API-only (no database key)** posture approved for Phase 1? | Determines credential scope and keeps service-role keys out of this project (G-3) | Yes — API only; revisit read-only DB access only if polling proves inadequate |
| Q4 | Which **customer email sender/domain** is used, and who owns order-email content? | Customer email cannot be sent safely without it (deliverability + G-6 duplication risk) | Business decision; admin alerts can start immediately with an internal mailbox |
| Q5 | Is **workflow-1 scope** (§17) approved as the single first deliverable? | Prevents building ten workflows before validating one | Approve as specified |
| Q6 | Ledger storage: **n8n Data table** or **gateway-owned store**? | Affects the gateway surface and the strength of the idempotency guarantee (§11.2) | Start with the Data table; move to the gateway if atomicity is required |
| Q7 | Repository name/location and remote (`C:\dev\alveron_n8n` → `alveron-automation`?) | Needed before any code is committed | Confirm; no rename and no `git init` has been performed |

### 19.2 Non-blocking confirmations (needed before production use)

| # | Item |
|---|---|
| N1 | Production API hostname/TLS; whether a reverse proxy preserves `rawBody`; the `NODE_ENV` value (G-10, §16.7) |
| N2 | Whether `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`, `APP_URL` are set in production (§16.7) |
| N3 | Whether anything external already calls `processPendingReferrals` (§16.7) — affects the referral workflow's cadence |
| N4 | Confirmation of `GET /products` variant coverage for any future low-stock workflow (§16.6) |
| N5 | n8n deployment details: host (`n8n.alveronfashion.com`?), Docker, Postgres, Redis/queue need, and a backup of `N8N_ENCRYPTION_KEY` (§3.2). **The production VPS will not be touched from this repository** |
| N6 | Whether gaps G-1 … G-4 will be raised with the Alveron team now — they are written to be handed over as-is (§13) |

### 19.3 Explicitly NOT done in this phase

- No Alveron source, schema, migration or configuration was modified.
- No workflow, gateway, script or test code has been written yet.
- No production system, VPS, Paystack dashboard or n8n instance was contacted or changed.
- No credentials were created, requested or stored.

---

## Appendix A — How to reproduce the verification

| Claim | How it was checked |
|---|---|
| Guard semantics (§5.4) | Read `apps/api/src/common/{auth,roles,permissions,employee}.guard.ts` and `modules/rbac/rbac.service.ts` |
| No API-key auth | Repository-wide text search in `apps/api/src` for `api_key` / `x-api-key` — only RBAC permission seeds matched |
| No scheduler / no outbound webhooks | Repository-wide search for `@Cron`, `@nestjs/schedule`, `setInterval`, `webhook` |
| Outbound HTTP targets | Search for `fetch(` / `axios` → Resend, Paystack and Nominatim only |
| Broken order email | Verified `apps/api/src/lib/email-templates` does not exist while `orders.service.ts` requires `../../../src/lib/email-templates` |
| `GET /orders` has no pagination | Read `OrdersService.getAllOrders` (selects all orders + items + payments, filters in memory) |
| Referral trigger side effect | Read `referrals.controller.ts` (`me/stats` → `processPendingReferrals()` under `AuthGuard` only) and `referrals.service.ts` |
| Referral/credit rules and defaults | Read `referral-rules.ts`, `referrals.service.ts`, `credit.service.ts`, `migrations/016_referral_credits.sql` |
| Return window 48 h | Read `returns.service.ts` (`RETURN_WINDOW_MS = 48 * 60 * 60 * 1000`) |
| Rate limits | Read `app.module.ts` (ThrottlerModule 60/min) and `auth.controller.ts` (`@Throttle` 5/min on login) |
| CORS mismatch (§16.1) | Read `main.ts` (hardcoded production origins) against `docs/ALVERON_API.md` |
| Search-by-email bug (§16.5) | Read the `getAllOrders` search expression (`${order.email}` is not an `orders` column) |
| No health endpoint | Route inventory from `@Controller(...)` decorators — no health/status controller exists |
| n8n version and features | Official n8n releases page; `docs.n8n.io` pages (Webhook; HTTP Request common issues; error handling; environment variables for security, executions, queue mode, credentials, deployment; data tables); CLI flag schemas read from `packages/cli/src/commands/{export,import}/workflow.ts` in `n8n-io/n8n` |
| Local dev configuration | Read `apps/api/.env` (**names only** — values were not exported) and `apps/web/.env.local` |

## Appendix B — Deliverable checklist

| Brief requirement | Where |
|---|---|
| 1. What was learned from ALVERON_API.md | §2 |
| 2. What was learned from ALVERON_DATABASE.md | §8 (entities), §14 (domain rules) |
| 3. What was learned from ALVERON_EVENTS.md | §6, §9 |
| 4. Which n8n capabilities are relevant | §3 |
| 5. Which Alveron ↔ n8n integration points are immediately possible | §4 (IP-1, IP-2, IP-3) |
| 6. Which integration points are missing | §13 (G-1 … G-14) |
| 7. Recommended first real workflow | §17 |
| 8. Proposed repository structure | §18 |
| 9. Security considerations | §10 (auth §5, idempotency §11, errors §12) |
| 10. What must be verified before implementation | §19 |
| Architecture requirement (§3 of brief) | §1 |
| Authentication requirement (§5) | §5 |
| Webhooks requirement (§6) | §6 |
| API communication requirement (§7) | §7 |
| Database requirement (§8) | §8 |
| Events requirement (§9) | §9 |
| Order / customer / referral / credit / returns / shipping / admin coverage | §14, §15 |

---

## 20. Status

**Analysis complete. Implementation has NOT started.**

Awaiting explicit approval for Q1–Q7 (§19.1) — in particular **Q2** (service account) and **Q5** (workflow-1 scope). On approval the sequence is:

```text
Phase 4   integration layer  (config → auth → http → client → schemas → errors → logger)
Phase 5   gateway surface + connectivity check against dev Alveron
Phase 6   workflow 1 end-to-end on dev Alveron (real order, real payment path)
Phase 7   error handling + explicit backoff
Phase 8   idempotency ledger + duplicate-suppression proof
Phase 9   observability + error workflow + alert-storm control
Phase 10  only then: additional workflows (referral coordination next)
```