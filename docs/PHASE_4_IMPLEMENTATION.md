# Phase 4 implementation status — SUBSTANTIALLY IMPLEMENTED, NOT PRODUCTION-READY

Alveron business truth is untouched. The gateway is the integration boundary. n8n is orchestration only.
This file states exactly what exists, what was executed, and what was NOT verified.

## Implemented files

- Scaffolding: package.json, package-lock.json (dev deps only: typescript + @types/node; zero runtime deps), tsconfig.json, .gitignore, .env.example (names + safe examples only), README.md.
- src/integrations/alveron/: config.ts (fail-fast; ADMIN_ALERT_EMAIL, sqlite: LEDGER_DATABASE_URL, gateway key >= 32 chars, loopback-only API, writes/production refused), errors.ts, logger.ts (metadata allowlist, credential redaction), http.ts (path-allowlisted admin-login + orders GET, serialized scheduling <= 40 req/min, timeout, bounded body, redirects rejected, retry only for 429/5xx/network, never 400/401/403/404 or malformed), auth.ts (single-flight cached sessions, expiry from session metadata, re-auth on expiry or 401 with session-identity fencing, identity validation: profile admin + active employee + RBAC slug admin), schemas.ts (documented field names; NGN + paid normalization with original values retained; notification-eligibility validation), client.ts (typed getOrders/getOrder with one re-auth retry on 401), index.ts (public surface).
- src/services/paid-order-discovery.ts: candidates from full GET /orders list (G-1 documented), local paid filter, no invented pagination.
- src/workflows/: notification-runner.ts (claim/complete/fail with provider namespace scoping) and paid-order-confirmation.ts (gateway-facing run: discovery, atomic claims, fresh detail fetch, validation, customer confirmation then admin alert, separate ledger keys, sanitized result with runId).
- src/ledger/sqlite-ledger.ts: automation-local SQLite (node:sqlite), PRIMARY KEY + single-statement conditional upsert claim, owner-fenced completion (LEDGER_FAILURE on loss), FAILED retry cap, permanent SUCCESS suppression, no stale auto-reclaim, no pruning.
- src/providers/email/index.ts: EmailProvider interface + ConsoleEmailProvider (simulated only; recipient/subject redacted) + NotificationNotSent for definite non-delivery.
- src/gateway/: application.ts (composition), server.ts (x-gateway-key constant-time check, single workflow route + health, strict empty-JSON body, 401/404/405/413/415/400 mapping, no proxy routes, sanitized replies), start.ts (loopback bind, structured start/stop).
- scripts/: verify-env.ts, check-alveron-connectivity.ts (read-only; reports counts, never secrets), configure-workflow.mjs (clamps schedule 5..59 min, keeps workflow inactive), export-workflows.mjs / import-workflows.mjs (n8n CLI wrappers; clear error when n8n absent).
- n8n/workflows/paid-order-confirmation.json (inactive; retryOnFail=false; strict sanitized result validation), n8n/workflows/error-handler.json (Error Trigger + sanitized classification; no automatic replay), n8n/README.md, n8n/templates/README.md, n8n/data-tables/README.md (gateway owns the ledger).
- tests/unit (config, auth, HTTP resilience incl. per-status retry matrix, currency guard, logger redaction), tests/contract (stub-server login+GET; full mock HTTP end-to-end), tests/security (gateway auth/proxy/body, missing email fail-closed), tests/unit/notification-slice.test.ts, tests/live/live.test.ts (opt-in, SKIPPED without prerequisites).

## Verification executed (Node 24.7.0, this machine)

- npm ci --no-audit --no-fund — succeeded (3 packages).
- npm run typecheck — passed.
- npm test (build + node --test "dist/tests/**/*.test.js") — final: 26 tests, 25 pass, 0 fail, 1 skip.
- node --test dist/tests/live/live.test.js — 1 skipped with reason "LIVE dev prerequisites not configured … NOT RUN" (exit 0), proving the live harness reports honestly rather than fabricating.

Coverage highlights: canonical error redaction; real local stub HTTP login + bearer GET; mock HTTP end-to-end (gateway → auth → discovery → detail → simulated customer + admin notifications → ledger SUCCESS; second run fully suppressed; no Alveron token/password/gateway key/customer email in responses; only GET + admin-login requests issued); concurrent same-event claims (one send); restart persistence; ambiguous-send blocking (PENDING, no resend); config contract incl. writes/production/loopback refusals; retry matrix (429/500/502/503/504 retried once-then-success; 400/401/403/404 never retried; timeout bounded; malformed JSON terminal); unpaid/unknown status exclusion; invalid list is an error, never "no orders"; currency guard (non-NGN fails closed); logger redaction of password/token/authorization/body.

## Critical semantics

- Console SUCCESS = simulated processing, NOT a delivered email. Real providers are unselected (Q4).
- Exactly-once external delivery is not guaranteed without provider idempotency; ambiguous sends stay PENDING for manual reconciliation and cannot be auto-resent. Failed ledger completion also blocks resend.
- Full-list discovery (G-1) may be truncated upstream; no completeness guarantee.
- The contract test titled "real local HTTP contract" uses a local stub server, NOT live Alveron.

## Not done / NOT verified

- LIVE dev connectivity, authentication or notifications: NOT RUN (no dev service account credentials or confirmed genuinely paid dev order were provided). tests/live exists and reports this honestly.
- n8n runtime: no n8n CLI/package/instance present on this machine (checked PATH, node_modules, port 5678); workflows were NOT imported, triggered or executed; error-workflow binding must be set manually in a real instance (see n8n/README.md).
- No cross-process SQLite contention test (current concurrency proof uses concurrent promises in one process; the SQL upsert is the atomicity boundary).
- No formatter/linter added (strict tsc only); no production deployment, VPS, Docker, DNS or n8n install; PAYSTACK and Supabase service-role secrets are absent from this repository by design.
- G-1..G-13 and documented Alveron discrepancies remain open and are consciously not worked around.

## Operator requirements

- Environment variables (names in .env.example; values only from a secret store): ALVERON_API_BASE_URL (loopback dev), ALVERON_SERVICE_EMAIL, ALVERON_SERVICE_PASSWORD, GATEWAY_API_KEY (>=32 chars), ADMIN_ALERT_EMAIL, LEDGER_DATABASE_URL, EMAIL_PROVIDER (console|unknown); optional LOG_LEVEL, GATEWAY_HOST/PORT, HTTP_* tuning.
- Alveron owner must provision the automation service account (profiles.role=admin, active employees row with RBAC slug admin) — never created by this repo.
- Human approval still needed for: real email provider/domain (Q4), live-dev test authorization, n8n instance deployment, any future write path (stays disabled).

## Phase 5 candidates

Scheduled trigger of Alveron's processPendingReferrals via GET /referrals/me/stats (confirmed side effect, no scheduler exists in Alveron); admin alert channel selection; real email provider adapter; incremental order listing (requires Alveron-side change, G-1); outbound event stream (G-2).
