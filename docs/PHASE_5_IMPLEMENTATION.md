# Phase 5 implementation status — SCHEDULED REFERRAL QUALIFICATION

**Date:** 2026-09-16 · Phase 4 remains intact; this phase extends it. Alveron is still the source of truth.
Labels: **CONFIRMED** (verified in Alveron source / executed here), **PROPOSED**, **UNKNOWN**.

## 1. Objective

Trigger Alveron's **existing** `processPendingReferrals()` on a schedule. No referral eligibility, reward,
credit, threshold, timing or status rule is implemented in this repository or in n8n.

```text
SCHEDULE → PRIVATE GATEWAY → AlveronClient → POST /auth/admin-login → cached token
        → GET /referrals/admin/stats → ALVERON runs its own processPendingReferrals()
```

## 2. Source verification (CONFIRMED — read from `C:\dev\alveron\apps\api`)

| # | Finding |
|---|---|
| V1 | `processPendingReferrals()` selects `referrals` where `status='pending'` with **no user filter** → it processes **ALL pending referrals globally**. |
| V2 | `GET /referrals/me/stats` requires only `AuthGuard` and awaits `processPendingReferrals()` before responding. |
| V3 | `GET /referrals/admin/stats` requires `AuthGuard` + `RolesGuard` + `@Roles('admin')` and also awaits it before responding. |
| V4 | **The `/referrals/me/stats` comment is wrong**: it claims "for this referrer" while the service has no referrer filter. |
| V5 | **Both endpoints swallow processing errors** (`.catch(() => undefined)`) → **HTTP 200 does NOT prove processing succeeded**, and no processed count is returned. |
| V6 | `getAdminReferralStats()` returns **aggregates only** (no emails, names, codes or per-referral rows). |
| V7 | Stats are computed **after** processing, so `pending` is a post-processing snapshot; `pending > 0` means "not yet eligible", not failure. |
| V8 | Processing is **idempotent**: `qualifyReferral` early-returns without a pending referral and requires delivered + paid + return window elapsed; `awardReward` has an app-level check **and** a unique partial index on `credit_transactions.referral_id`. |
| V9 | Neither endpoint accepts or needs query parameters. |
| V10 | Per-referral failures are individually swallowed → a partially-progressed run is safe to repeat. |
| V11 | The referral/credit writes belong to Alveron alone; this repository never writes them. |

## 3. Endpoint used (DECISION — PROPOSED choice, CONFIRMED capability)

`GET /referrals/admin/stats` via `AlveronClient.triggerReferralProcessing()`.

- **Authentication required:** `AuthGuard` (valid Supabase session JWT) **and** `RolesGuard` with `@Roles('admin')`. The Phase 4 service account is deliberately admin-equivalent (Q2), so **no new privilege is introduced**.
- **Side effect:** the endpoint awaits `processPendingReferrals()` **before** building its response, so calling it invokes Alveron's global referral qualification.
- **Why not `/referrals/me/stats`:** it is a customer-scoped endpoint whose comment already contradicts its implementation (V4). If Alveron later aligns it to the comment, a schedule built on it would silently stop processing anything. The admin endpoint is semantically the global/bulk operation and returns PII-free aggregates. Switching is a one-line change if needed.
- **Rejected:** looping over customers, per-user calls, or `/referrals/admin/all` (returns per-referral PII and does not trigger processing).

## 4. Scope of `processPendingReferrals()` — **ALL pending referrals globally**

**CONFIRMED from source, not inferred:** the query filters only on `status='pending'`; there is no `referrer_user_id` filter and no parameter. Therefore *either* endpoint triggers global processing, and the automation does **not** need to enumerate users.

## 5. Security model (CONFIRMED by tests)

- No Supabase service-role key anywhere in this repository or in n8n.
- No Alveron bearer/refresh token leaves the gateway; the gateway response contains only sanitized fields.
- The gateway route requires `x-gateway-key` (constant-time comparison); unauthenticated callers never reach Alveron (asserted: 0 upstream calls).
- No generic proxy: `/internal/proxy`, `/internal/alveron`, `/internal/request`, `/alveron/*` and query-string variants all return 404 (asserted).
- Only the confirmed path `/referrals/admin/stats` is reachable; every other Alveron path is rejected locally **before** any read is forwarded (asserted).
- `FEATURE_ENABLE_ALVERON_WRITES=false` unchanged; **no write method exists** on the client.
- No direct database access; no Paystack involvement; loopback-only API base URL.

## 6. Idempotency and concurrency (CONFIRMED by tests)

**Run identity:** `windowId` = the configured interval bucket from a clock, e.g. `2026-09-16T10:00Z`;
`executionKey = referral-qualification:{windowId}`. Configurable via `REFERRAL_QUALIFICATION_POLL_MINUTES`
(min 5, max 1440, default 60).

| Situation | Behaviour | Test evidence |
|---|---|---|
| n8n retry / replay / concurrent duplicate **inside one window** | exactly one Alveron invocation; the others return `duplicate` | two simultaneous runs → 1 invocation, statuses `['completed','duplicate']` |
| **Next scheduled window** | a **new key**, so it always executes — Run A cannot suppress Run B | Run B executes at the next window and calls Alveron again |
| Alveron call fails | ledger `FAILED`; result `failed` — **never success** | failure test asserts `status:'failed'`, `sideEffectInvoked:false` |
| A later call in the same failed window | may retry, bounded by attempts | after failure a same-window retry succeeds |
| Attempts exhausted | `duplicate` with `ATTEMPTS_EXHAUSTED`, no further call | bounded-retry test with `maxAttempts=1` |

- **Concurrency boundary:** the single atomic conditional SQL upsert in `SqliteLedger.claim` — not an in-process flag, not a distributed lock, so a second gateway process gets the same guarantee.
- **The ledger records only "this automation invocation happened."** It never stores or mirrors referral/credit state and never becomes a substitute for Alveron's.
- Duplicate invocation is safe here (V8/V10) — unlike outbound notifications, where Phase 4 keeps ambiguous sends `PENDING`.
- Documented drift: if n8n's schedule is shorter than the window, some windows are suppressed (harmless no-ops).

## 7. Retry behaviour (reused Phase 4 policy, unchanged)

| Class | Retried? | Verified in Phase 5 tests |
|---|---|---|
| 429 | Yes (+ `Retry-After`) | retried then succeeded (2 calls) |
| 5xx (500/502/503/504) | Yes, bounded | 3 calls (1 + 2 retries) then `ALVERON_SERVER_ERROR` |
| Timeout / network | Yes, bounded | 2 calls then `NETWORK_ERROR` |
| 400 / 403 / 404 | **No** | 403 → 1 call, `AUTHORIZATION_ERROR`; 404 → 1 call, `VALIDATION_FAILED` |
| Malformed body / wrong shape | **No** | 1 call, `INVALID_RESPONSE` |
| 401 | Re-auth once via the **existing** `AlveronClient.read()` | 401 → 2 logins then success; persistent 401 → `AUTHENTICATION_ERROR` |

Backoff is explicit (base 1 s, ×2, cap 8 s, jitter-free, `Retry-After` honoured, ≤3 retries). n8n provides only a fixed wait; nothing here claims n8n supplies exponential backoff.

Failure categories: `CONFIGURATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `RATE_LIMITED`, `ALVERON_SERVER_ERROR`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `VALIDATION_FAILED`, `LEDGER_ERROR`, `UNKNOWN_ERROR` (PROPOSED vocabulary; `VALIDATION_FAILED`/`LEDGER_ERROR` extend the brief's "such as" list instead of collapsing to `UNKNOWN_ERROR`).

## 8. Response validation and honesty

The result distinguishes **what is actually known**:

```json
{ "runId": "...", "status": "completed", "endpoint": "/referrals/admin/stats",
  "windowId": "2026-09-16T10:00Z", "startedAt": "...", "completedAt": "...", "durationMs": 12,
  "httpSucceeded": true, "sideEffectInvoked": true, "processedCount": null,
  "observations": { "total": 4, "pending": 1, "qualified": 1, "rewarded": 1, "cancelled": 1 },
  "message": "Alveron referral processing invoked; the endpoint reports no processed count." }
```

- `processedCount` is **always `null`** — the endpoint reports no such figure (V5/V7). It is never invented.
- HTTP 200 alone is not treated as success; a wrong shape is `INVALID_RESPONSE`.
- `status: "duplicate"` is a **200** (legitimate no-op), while a real failure is **502** so n8n's error workflow triggers.
- Failure responses carry a category, never raw upstream text (asserted).

## 9. n8n workflow (CONFIRMED valid JSON; runtime NOT verified)

`n8n/workflows/referral-qualification.json` — inactive, credential-free:
Schedule (1 hour default) → HTTP Request (gateway key via **Header Auth credential**, `retryOnFail:false`) →
Code validation accepting `completed` **and** `duplicate`, otherwise throwing `REFERRAL_QUALIFICATION_FAILED:<category>`.

The Phase 4 `error-handler.json` is **reused**; its classifier now recognises both Phase 4 codes and Phase 5
categories, flags `transient`, and always sets `manualReplay:false` (no automatic replay; the gateway owns retries).

**Correction carried in this phase:** the Phase 4 HTTP Request node had one redundant `response` nesting level
(`options.response.response`), which was wrong for HTTP Request v4.2. Both workflows now use
`options.response = { fullResponse, neverError, responseFormat }`. n8n runtime behaviour is still **NOT verified**
(no n8n instance on this machine).

## 10. Files created / changed

**Created:** `src/services/referral-qualification-window.ts`, `src/workflows/referral-runner.ts`,
`src/workflows/referral-qualification.ts`, `tests/unit/referral-qualification.test.ts`,
`tests/contract/referral-endpoint.test.ts`, `tests/security/referral-gateway.test.ts`,
`n8n/workflows/referral-qualification.json`, `docs/PHASE_5_IMPLEMENTATION_PLAN.md`, `docs/PHASE_5_IMPLEMENTATION.md`.

**Changed (additive):** `src/integrations/alveron/errors.ts` (categories), `config.ts` (window minutes),
`schemas.ts` (`ReferralStats`/`parseReferralStats`), `http.ts` (path allowlist + refined codes; retry logic unchanged),
`client.ts` (`triggerReferralProcessing`), `src/ledger/sqlite-ledger.ts` (param rename, optional message id, reasons),
`src/gateway/server.ts` (route table, second route), `gateway/application.ts`, `gateway/start.ts`,
`n8n/workflows/{paid-order-confirmation,error-handler}.json`, `scripts/configure-workflow.mjs`, `.env.example`,
`tests/security/gateway.test.ts` + `tests/contract/end-to-end.test.ts` (constructor signature).

**No Alveron file was modified.**

## 11. Tests (executed, Node 24.7.0)

```powershell
npm run typecheck      # passed
npm test               # 49 tests: 48 pass, 0 fail, 1 skip (live)
```

New Phase 5 coverage (23 tests): window identity + bounds · success recorded and same-window repeat suppressed without a second call · **Run A does not suppress Run B** · two simultaneous runs → exactly one invocation · failure never reported as success and stays retryable · attempts bounded (`ATTEMPTS_EXHAUSTED`) · failure-category classification · real local HTTP success (login → bearer GET) · 401 → exactly one re-auth then success · persistent 401 → `AUTHENTICATION_ERROR` · 403 → 1 attempt, `AUTHORIZATION_ERROR` · 404 → 1 attempt · 429 → retried then success · 5xx → 3 calls then `ALVERON_SERVER_ERROR` · timeout → bounded, `NETWORK_ERROR` · malformed body → terminal, `INVALID_RESPONSE` · 200 with wrong shape → `INVALID_RESPONSE` · non-allowlisted Alveron paths rejected locally with **no read forwarded** · gateway auth (0 upstream calls unauthenticated) · no proxy/forwarding · sanitized response (no key/token/`@`) · duplicate → 200 no-op · failure → 502 with category and no success claim.

No referral business rules are tested or re-implemented — Alveron responses are mocked/stubbed and only orchestration is asserted.

## 12. Live testing

**NOT RUN.** No live referral-processing call was made. `tests/live/` remains opt-in and reports SKIPPED without an approved development environment, service account and safe test referral data. Production referral data and credentials are never used.

## 13. Deployment status

**CONFIRMED untouched:** no VPS access, no Docker/n8n install, no DNS/SSL, no production activation, no workflow published (`active:false` in all three JSONs), no production credentials created or used, no production Alveron/Paystack/Supabase contact.

## 14. Remaining decisions

| # | Item | Status |
|---|---|---|
| D1 | Production `ALVERON_API_BASE_URL` | **UNKNOWN** (G-10); loopback-only restriction unchanged |
| D2 | Automation service-account provisioning (`profiles.role='admin'` + active employee, RBAC slug `admin`) | owner action (Q2) — required before any live run |
| D3 | Real email/notification provider for admin alerts | open (Q4); Phase 5 ships an **internal** sanitized result only and claims no email was sent |
| D4 | n8n instance deployment + import + error-workflow binding | open; runtime unverified |
| D5 | Live-dev authorization | open; explicit human approval required |
| D6 | Endpoint choice | `/referrals/admin/stats` chosen (PROPOSED); switch to `/referrals/me/stats` is a one-line change if Alveron's admin endpoint ever changes |

## 15. Preserved limitations

G-1 (full-list order polling) · G-2 (polling only) · G-3 (no DB access) · G-4 (admin-equivalent service account) · G-5 … G-13, plus the Phase 4 discrepancies (CORS mismatch, `payment_status` casing, dual inventory/shipping/returns paths, coupon `used_count`, broken order-email search) **and the newly recorded V4** (`/referrals/me/stats` comment vs implementation). None were "fixed" here.

Additional Phase 5 limitation (CONFIRMED): because Alveron swallows processing errors (V5), this automation can state only that the endpoint was invoked — it **cannot** confirm how many referrals were processed or that processing succeeded. Alveron-side observability (or an outbound event stream, G-2) would be needed for that.
