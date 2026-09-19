# Phase 5 Implementation Plan — Scheduled Referral Qualification

**Status:** plan (written before implementation, per Step 29) · **Date:** 2026-09-16
**Scope:** trigger Alveron's existing `processPendingReferrals()` on a schedule. No referral business logic in this repository.

---

## 1. Objective

Alveron owns referral rules. `processPendingReferrals()` exists but **has no scheduler**; it only runs as a side effect of two read endpoints. Phase 5 adds scheduling, authentication, resilience, observability and safe orchestration around that *existing* Alveron behaviour.

```text
SCHEDULE → TRIGGER ALVERON → ALVERON RUNS ITS OWN processPendingReferrals() → ALVERON REMAINS SOURCE OF TRUTH
```

## 2. Source verification (CONFIRMED, read from `C:\dev\alveron\apps\api`)

| # | Finding | Evidence |
|---|---|---|
| V1 | **`processPendingReferrals()` is GLOBAL, not per-user.** It selects `referrals` where `status='pending'` with **no user filter**, then calls `qualifyReferral(referred_order_id)` per row. | `referrals.service.ts` L326–336 |
| V2 | `GET /referrals/me/stats` requires **only `AuthGuard`** (any authenticated user) and awaits `processPendingReferrals()` **before** computing its response. | `referrals.controller.ts` L33–52 |
| V3 | `GET /referrals/admin/stats` requires **`AuthGuard` + `RolesGuard` + `@Roles('admin')`** and also awaits `processPendingReferrals()` before responding. | `referrals.controller.ts` L62–68 |
| V4 | **The controller comment on `/referrals/me/stats` is wrong.** It says "Process any pending referrals **for this referrer**", but the service has no referrer parameter or filter. | comment L36 vs service L327–330 |
| V5 | **Both endpoints swallow processing errors**: `await this.service.processPendingReferrals().catch(() => undefined)`. **HTTP 200 does NOT prove referral processing succeeded**, and no processed count is returned. | controller L37, L66 |
| V6 | `getAdminReferralStats()` returns **aggregates only** — `total, pending, qualified, rewarded, cancelled, totalDiscounts, totalRewards, totalCreditIssued, totalCreditRedeemed, conversionRate`. No emails, names, codes or per-referral rows. | `referrals.service.ts` L383–411 |
| V7 | The stats are computed **after** processing, so `pending` is a **post-processing snapshot**; `pending > 0` means "not yet eligible", not failure. | service L384–393 |
| V8 | **Processing is idempotent.** `qualifyReferral` early-returns when no `pending` referral exists for the order and requires order `delivered` + paid + return window elapsed; `awardReward` checks for an existing `referral_reward` row **and** is protected by a partial unique index on `credit_transactions.referral_id`. | service L250–284, L286–324; migration 016 |
| V9 | No query parameters are accepted or needed by either endpoint. | controller L33, L62 |
| V10 | Per-referral failures are individually swallowed (`.catch(() => undefined)`), so a partially-progressed run is safe to repeat. | service L333 |
| V11 | Ledger-style side effects are Alveron's alone: `processPendingReferrals` writes `referrals.status` and `credit_transactions`. The automation must never write these. | service L276–323 |

## 3. Endpoint selection (DECISION)

**Use `GET /referrals/admin/stats`.**

| Reason | Detail |
|---|---|
| Semantics | A scheduled, global, bulk operation — matching an admin/bulk endpoint rather than a customer endpoint |
| Clean response | Pure aggregates (V6) → safest thing to validate and sanitize; no per-referral PII to strip |
| Stability | V4 shows the customer endpoint's comment already contradicts its implementation. If Alveron later aligns `/referrals/me/stats` to its comment (per-referrer), a scheduled job built on it would **silently degrade to processing nothing**. The admin endpoint is not described as per-user. |
| Privilege | Phase 4's service account is deliberately admin-equivalent (Q2/G-4), so `@Roles('admin')` is already satisfied; no new privilege is introduced |

`GET /referrals/me/stats` is **documented as the fallback** if the admin endpoint ever changes; switching is a one-line change in `AlveronClient`. It is not used, because relying on a customer-scoped endpoint's unintended side effect is the more fragile choice.

**Explicitly rejected:** looping over customers, calling `/referrals/me/stats` per user, or calling `/referrals/admin/all` (which returns per-referral PII and does not trigger processing).

## 4. Authentication (reuse only — no new mechanism)

```text
n8n → GATEWAY_API_KEY → private gateway → AlveronClient → POST /auth/admin-login
   → cached Supabase access token → GET /referrals/admin/stats
```

Phase 4's `AuthManager` (single-flight login, expiry from session metadata, session-identity fencing) and `AlveronClient.read()` (single re-auth retry on 401) are reused unchanged. The bearer token never leaves the gateway; no Supabase service-role key exists in this repository or in n8n.

## 5. Modules (reusing Phase 4 conventions)

The brief suggested `src/services/referral-discovery.ts`. There is **no discovery step** here (nothing is enumerated; we must not loop over customers), so a "discovery" service would be a misleading name. The Phase 4 two-tier convention (`services/` = determine/validate the unit of work, `workflows/` = claimed execution + orchestration) is preserved instead:

| File | Responsibility | Phase 4 analogue |
|---|---|---|
| `src/services/referral-qualification-window.ts` | Deterministic run identity: `windowId` from an injected clock + configured interval; `executionKey = referral-qualification:{windowId}` | `services/paid-order-discovery.ts` |
| `src/workflows/referral-runner.ts` | One claimed execution: atomic claim → call Alveron → mark SUCCESS/FAILED; never marks success on failure | `workflows/notification-runner.ts` |
| `src/workflows/referral-qualification.ts` | Workflow entry: claim, invoke, classify failure, build the sanitized result | `workflows/paid-order-confirmation.ts` |

Additive changes to existing files (no Phase 4 behaviour weakened):

| File | Change |
|---|---|
| `src/integrations/alveron/config.ts` | add `referralWindowMinutes` from `REFERRAL_QUALIFICATION_POLL_MINUTES` (min 5, max 1440, default 60) |
| `src/integrations/alveron/schemas.ts` | add `ReferralStats` + `parseReferralStats` (strict integer validation of the confirmed aggregate fields) |
| `src/integrations/alveron/errors.ts` | add `FailureCategory` + `classifyFailure()` (additive; existing codes unchanged) |
| `src/integrations/alveron/http.ts` | extend the path allowlist to exactly `/referrals/admin/stats`; refine codes to `NETWORK_ERROR` / `INVALID_RESPONSE` / `AUTHORIZATION_ERROR` (**retry behaviour unchanged**) |
| `src/integrations/alveron/client.ts` | add `triggerReferralProcessing(): Promise<ReferralStats>` |
| `src/ledger/sqlite-ledger.ts` | rename the `orderId` parameter to `resourceId`; make `markSuccess`'s message id optional; extend allowed failure reasons |
| `src/gateway/server.ts` | add exactly one route: `POST /internal/workflows/referral-qualification/run` |
| `src/gateway/application.ts` | compose the referral workflow alongside the paid-order workflow |

**No write methods are added.** `FEATURE_ENABLE_ALVERON_WRITES` stays `false`. The only Alveron calls in the entire repository remain: `POST /auth/admin-login`, `GET /orders`, `GET /orders/:id`, `GET /referrals/admin/stats`.

## 6. Gateway route

`POST /internal/workflows/referral-qualification/run` — loopback-bound, `x-gateway-key` (constant-time), `application/json`, **empty object body only** (any field ⇒ 400, matching Phase 4's strict contract). No `/internal/proxy`, no `/internal/alveron`, no URL or method forwarding. The gateway performs the Alveron `GET`; the *automation command* is a POST.

## 7. Run identity, idempotency and concurrency

- `windowId = floor(now / (referralWindowMinutes × 60_000))` rendered as a UTC ISO minute stamp (e.g. `2026-09-16T10:00Z`); `executionKey = referral-qualification:{windowId}`.
- The ledger key is **per window**, therefore:
  - n8n retry / accidental replay / concurrent duplicate **within the same window** → suppressed (`duplicate`), because the claim is one atomic SQL statement (Phase 4 mechanism, unchanged);
  - the **next scheduled window is a new key and always executes** — Run A cannot suppress Run B.
- Ledger states: `SUCCESS` → `duplicate` (never re-invoked); `PENDING` → `duplicate` (`ALREADY_RUNNING`); `FAILED` with attempts left → re-claimable (safe per V8/V10); `FAILED` exhausted → `duplicate` (`ATTEMPTS_EXHAUSTED`).
- **The ledger never substitutes for Alveron's referral state.** It records only "this automation invocation happened" — never referral or credit state — and never claims success when Alveron failed.
- Documented drift hazard: if n8n's schedule is shorter than `REFERRAL_QUALIFICATION_POLL_MINUTES`, some windows are suppressed (harmless no-ops, since processing is idempotent). Operators should keep them equal.

## 8. Response validation and honesty

- HTTP 200 alone is **not** success (V5). The result therefore distinguishes `httpSucceeded`, `sideEffectInvoked`, and the observed aggregate snapshot.
- `processedCount` is **NOT determinable** from this endpoint (V5/V7) and is reported as `null` with an explicit note — never invented.
- An unexpected response shape ⇒ `INVALID_RESPONSE` failure, not success.
- `pending > 0` is **not** an error (V7): it means referrals remain outside their return window.

## 9. Retry and error classification

Phase 4 HTTP policy is reused unchanged: retry `429`/`5xx`/timeout/network with explicit bounded backoff (base 1s, ×2, cap 8s, `Retry-After` honoured, ≤3 retries); never retry `400`/`401`(transport)/`403`/`404`/malformed responses. `401` recovery is the existing `AlveronClient.read()` single re-auth — no second token implementation.

`classifyFailure()` maps to: `CONFIGURATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `RATE_LIMITED`, `ALVERON_SERVER_ERROR`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `VALIDATION_FAILED`, `LEDGER_ERROR`, `UNKNOWN_ERROR`. (The brief's list is introduced by "such as"; `VALIDATION_FAILED` and `LEDGER_ERROR` are additive refinements of Phase 4's canonical codes rather than collapsing everything into `UNKNOWN_ERROR`.)

## 10. Sanitized result

`{ runId, workflow, status, endpoint, windowId, startedAt, completedAt, durationMs, httpSucceeded, sideEffectInvoked, processedCount: null, observations?, duplicate?, failureCategory?, message }`.

No tokens, sessions, passwords, gateway key, customer emails, names, referral codes, credit balances or per-referral rows (V6 makes that natural). Admin notification remains **internal** — Phase 4 has no real provider (Q4 open) — and nothing claims an email was sent.

## 11. n8n

New inactive `n8n/workflows/referral-qualification.json` (Schedule → HTTP Request → Code validation → throw canonical failure). `active: false`, credential-free, gateway key via a Header Auth credential. The existing Phase 4 `error-handler.json` is **reused** (its classifier list is extended with the new categories); no automatic replay. No install, deployment or activation.

## 12. Tests

Unit/contract/security: success; 401 (+ single re-auth, then failure); 403; 404; 429; 5xx; timeout; malformed response; **invalid shape ⇒ failure, not success**; concurrency (two simultaneous identical windows ⇒ one invocation); **window separation (Run A success does not suppress Run B)**; failure never reports success; sanitization (no token/password/gateway key/email in the gateway response); path-allowlist rejection of arbitrary Alveron paths; classification categories; config bounds. Referral **rules** are never re-implemented — the Alveron response is mocked and only orchestration is asserted.

## 13. Live test

**NOT RUN.** `tests/live/` remains opt-in and reports SKIPPED without an approved dev environment and service account. No live referral processing occurs in this phase, and production referral data is never used.

## 14. Preserved limitations

G-1…G-13 and all Phase 4 discrepancies remain open and are **not** "fixed" (CORS mismatch, `payment_status` casing, dual inventory/shipping/returns paths, coupon `used_count`, broken order-email search), plus **V4** recorded here. No direct DB access, no Supabase service-role key, no Paystack involvement, no production URL assumption (G-10).

## 15. Files expected to change

`src/integrations/alveron/{config,schemas,errors,http,client}.ts` · `src/ledger/sqlite-ledger.ts` · `src/services/referral-qualification-window.ts` (new) · `src/workflows/{referral-runner,referral-qualification}.ts` (new) · `src/gateway/{server,application}.ts` · `n8n/workflows/referral-qualification.json` (new) · `n8n/workflows/error-handler.json` · `scripts/configure-workflow.mjs` · `.env.example` · `README.md` · `docs/PHASE_5_IMPLEMENTATION_PLAN.md` + `docs/PHASE_5_IMPLEMENTATION.md` · new tests under `tests/`. **No Alveron file is modified.**

