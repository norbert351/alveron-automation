# Phase 6 implementation status — self-hosted n8n runtime + dev integration verification

> Historical Phase 6 snapshot. Current routes, Telegram delivery, credential loading, and deployment gates are
> documented in the root README, `n8n/README.md`, and `deploy/OPERATOR_RUNBOOK.md`.

**Date:** 2026-09-20 · Phase 4/5 implementation unchanged (49 tests still green). **No production deployment.**
Labels: **CONFIRMED** (executed here) · **MOCK** (verified against the local mock Alveron, *not* live) · **NOT RUN** · **BLOCKED**.

---

## 1. n8n version (re-verified against the official repository)

| Item | Value |
|---|---|
| Pin used | **n8n 2.39.8** — stable, published 2026-09-18 (`n8n --version` → `2.39.8` after install) |
| Why | the brief requires verifying the current stable release rather than reusing Phase 4's snapshot (2.39.6) |
| Rejected | 2.39.7 (superseded), 1.123.81 (old line), 2.40.x (beta), `latest`/`next`/`master` |
| Installed where | `.n8n-runtime/` (git-ignored, 2370 packages) via `npm install n8n@2.39.8` |

**CONFIRMED:** the pinned release installs and its CLI runs (`--version` returned `2.39.8`).

## 2. Runtime topology actually used here

```text
Alveron API (real) ................ UNKNOWN / unreachable (localhost:4000 not running, G-10)  → BLOCKED
        ↓ replaced for this phase by
mock Alveron (scripts/mock-alveron.mjs, 127.0.0.1:4600)  — SYNTHETIC DATA ONLY           → CONFIRMED
        ↓
Alveron Automation Gateway (127.0.0.1:8787, loopback, x-gateway-key)                     → CONFIRMED
        ↓
n8n 2.39.8 (self-hosted, pinned; local dev instance)                                     → installed, service BLOCKED
```

- The gateway stayed **loopback-only** — n8n is run natively (npm) rather than in Docker precisely so it can reach
  `127.0.0.1` without the gateway binding a non-loopback interface. **The Phase 4 security model is unweakened.**
- Docker was rejected for this pass: the daemon is not running, and container→host-loopback would have forced a
  non-loopback gateway bind.

## 3. What was verified at runtime (MOCK where marked)

`node scripts/runtime-verify.mjs` — **11/11 PASS** against the running gateway + mock upstream:

| # | Check | Result |
|---|---|---|
| 1 | gateway `/internal/health` with valid key | PASS |
| 2 | health rejects missing key (401) | PASS |
| 3 | health rejects wrong key (401) | PASS |
| 4 | referral first run → 200, `status: completed` | PASS |
| 5 | referral `sideEffectInvoked: true` | PASS |
| 6 | referral `processedCount: null` (never invented) | PASS |
| 7 | referral same-window repeat → 200 `duplicate: ALREADY_COMPLETED` | PASS |
| 8 | duplicate caused **no second upstream call** (mock `statsCalls 1 → 1`) | PASS |
| 9 | paid-order first run → `processed: 1, failed: 1` (mock has 1 valid paid + 1 paid-without-email + 1 unpaid) | PASS |
| 10 | paid-order repeat → `skipped: 1` (permanent suppression) | PASS |
| 11 | no secrets in gateway responses (no key/`Bearer`/`access_token`/`service_role`) | PASS |

**Gateway restart drill — CONFIRMED:** gateway stopped (port 8787 released), restarted with the same ledger file, then
the *same* window returned `duplicate / ALREADY_COMPLETED` with `sideEffectInvoked: false` → **ledger persistence and
duplicate suppression survive a restart**.

**Ledger evidence read back from `data/runtime-ledger.sqlite` (CONFIRMED):**

```
referral-qualification:2026-09-18T13:00Z   SUCCESS  attempts=1
development-console:paid-order-confirmation:<order>:customer  SUCCESS  provider_message_id=console:...
development-console:paid-order-confirmation:<order>:admin     SUCCESS  provider_message_id=console:...
development-console:paid-order-validation:<order>             FAILED   attempts=2   (missing customer email)
referral-qualification:2026-09-19T23:00Z   SUCCESS  attempts=1
```

This shows: window keys are distinct per scheduled window, customer/admin notifications have **separate** keys, the
missing-email order failed closed and was retried then bounded, and SUCCESS rows are terminal.

**Email mode (CONFIRMED):** `EMAIL_PROVIDER=console` → `simulated: true`. **NO REAL EMAIL WAS SENT.**

## 4. What was NOT verified (honest status)

| Item | Status | Reason |
|---|---|---|
| **Live Alveron connectivity** (gateway → real admin login → real read) | **BLOCKED** | `ALVERON_API_BASE_URL` is **UNKNOWN** (the brief forbids assuming `api.alveronfashion.com`; the local dev API on `localhost:4000` was **unreachable** — probed) and **no service-account credentials were supplied** (Q2). |
| **Live referral test data** (pending referral, referrer, referred customer, delivered+paid order) | **BLOCKED** | Requires the dev environment above; the brief forbids fabricating referral data. `LIVE REFERRAL TEST = BLOCKED`. |
| **n8n workflow import / execution / scheduled trigger** | **NOT RUN (environment)** | n8n 2.39.8 is installed and its CLI runs `--version`, but in this shell the CLI/server boot exceeds the 30‑second per-command ceiling (2370-package dependency graph), and background servers are killed when the parent shell is terminated by that ceiling. No interactive/persistent session is available to hold the instance up. |
| **n8n restart drill** | **NOT RUN** | Depends on a running n8n instance. |
| **Error-workflow binding + failure injection through n8n** | **NOT RUN** | Depends on a running n8n instance. The binding gap is closed *procedurally* (runbook step 2 + runtime-patch approach documented). |
| **Error workflow classification** | Verified by automated tests only | Phase 4/5 security + contract tests cover 401/403/404/429/5xx/timeout/malformed paths; the n8n Error Trigger itself was not exercised. |

**Nothing above is reported as passing.** No n8n execution, no live Alveron call, and no scheduled trigger was observed.

## 5. Security results (CONFIRMED)

- **No Alveron credentials in n8n**: n8n's runtime env file contains only `N8N_*` settings and the **non-secret** `GATEWAY_BASE_URL`; no service-account email/password, no JWT, no DB credential.
- **No service-role key, no Paystack secret, no Supabase key** anywhere in this repository, in n8n, or in any workflow JSON (scan clean; the only two matches were a test's own forbidden-string list and the verifier's hygiene regex).
- **No JWT reaches n8n**: gateway responses carry only sanitized fields; the runtime check asserts no `Bearer`/`access_token`/`refresh_token` in responses.
- **No generic proxy**: route table is exactly `paid-order-confirmation`, `referral-qualification`, `health`; `/internal/proxy`, `/internal/alveron`, `/internal/request`, `/alveron/*` are not registered (asserted in tests and re-checked at runtime for the referral path).
- **Gateway authentication enforced**: health and both routes reject missing/wrong keys (runtime PASS).
- **No secrets in workflow JSON**: all three workflows `active:false`, no literal `x-gateway-key`, no bearer literal.
- **Writes disabled**: `FEATURE_ENABLE_ALVERON_WRITES=false`; the client has no write methods.
- **Secrets never written to the repo**: runtime env files live in git-ignored `.n8n-runtime/` / `.n8n-state/`; `.gitignore` updated (`deploy/.env` ignored, `.env.example` kept).
- **Docker/VM untouched**, and no production host, DNS, proxy, certificate or Paystack configuration was contacted.

## 6. Operator actions still required

1. **Supply `ALVERON_API_BASE_URL`** for the target dev environment (currently UNKNOWN) and confirm it with the Alveron owners.
2. **Provision the automation service account** (`profiles.role='admin'`, active `employees` row with RBAC slug `admin`) and place its credentials in the gateway secret store — never in n8n or Git.
3. **Run the live dev verification** (`npm run verify:env`, `npm run check:connectivity`, then both workflow routes) once 1–2 exist; the connectivity script must prove admin login → cached session → authorized read → sanitized response.
4. **Stand up n8n on a host with a persistent session** (or the provided Docker compose), import the three workflows, create the Header Auth credential, bind the error workflow, configure schedules (15 min / 60 min), and keep everything inactive until approved.
5. **Run the n8n restart drill** and the error-workflow failure injection.
6. Decide the **referral schedule/window alignment** (15-min schedule + 60-min window ⇒ hourly invocations) and the **real email provider** (Q4).

## 7. Files created/changed in Phase 6

**Created:** `docs/PHASE_6_IMPLEMENTATION_PLAN.md`, `docs/PHASE_6_IMPLEMENTATION.md`, `deploy/docker-compose.yml`, `deploy/nginx-n8n.conf.template`, `deploy/OPERATOR_RUNBOOK.md`, `deploy/.env.example`, `scripts/mock-alveron.mjs`, `scripts/runtime-verify.mjs`, `scripts/run-gateway-with-env.mjs`, `scripts/run-n8n-dev.mjs`.
**Changed:** `.gitignore` (ignore `.n8n-runtime/`, `.n8n-state/`, `deploy/.env*`), `README.md` (Phase 6 section).
**Unchanged:** all `src/**` (no production code modified in Phase 6), all `tests/**` expectations, all workflow definitions except the Phase 5 correction already recorded.
**No Alveron file was modified.**

## 8. Known limitations carried forward

G-1…G-13 and all prior discrepancies remain open. Runtime caveat for this phase: n8n-side execution could not be observed here, so **"integration verified through a real self-hosted n8n" remains outstanding** even though the gateway chain is runtime-proven against a mock upstream.
