# Phase 4 Implementation Plan — Alveron Automation

**Status:** plan (written before implementation, as required by Step 1)
**Date:** 2026-09-16
**Scope:** integration layer, authentication, typed client, resilient HTTP, private gateway, ledger, email provider abstraction, tests, tooling, n8n Workflow 1 skeleton. **No deployment, no production, no Alveron changes.**

---

## 1. Repository state (Step 1 inspection results)

| Item | Finding |
|---|---|
| `package.json` | **did not exist** (created during this phase) |
| `tsconfig.json` | **did not exist** (created during this phase) |
| `node_modules` | **did not exist** |
| `.git` | **does not exist** (not yet a git repository) |
| `.env` / `.env.example` | **did not exist** |
| `src/`, `tests/`, `scripts/`, `n8n/` | **did not exist** |
| `docs/` | 4 documents: `ALVERON_API.md`, `ALVERON_DATABASE.md`, `ALVERON_EVENTS.md`, `INTEGRATION_ANALYSIS.md` |
| Framework already selected? | **No** — greenfield |
| TypeScript configured? | **No** |
| Existing HTTP/validation/logging/persistence utilities? | **None** |
| Existing n8n workflow files? | **None** |

Nothing existing needed preserving or retrofitting: the tree is created fresh, following the Q7 structure with the minimal justifiable toolchain, while keeping the architectural separation (integration layer / services / ledger / providers / gateway / n8n).

### 1.1 Runtime capabilities verified on this machine

| Capability | Verified result |
|---|---|
| Node.js | **v24.7.0** |
| npm | 11.5.1 |
| Global `tsc` | **not installed** → TypeScript added as a dev dependency |
| npm registry reachable | **yes** |
| `node:sqlite` (`DatabaseSync`) | **available** (no flag required; emits an ExperimentalWarning) |
| Atomic claim primitive | verified: `INSERT … ON CONFLICT(key) DO NOTHING` → `changes` = 1 then 0 |
| `fetch`, `AbortSignal.timeout` | available (global) |
| `node:worker_threads` | available (used to prove cross-thread claim atomicity) |
| `node:test` | available (test runner) |

---

## 2. Toolchain decision

| Decision | Choice | Justification |
|---|---|---|
| Language | **TypeScript 5.9.3** (dev dependency, compiled to `dist/`) | Step 4 requires a *typed* client with explicit schemas; the brief explicitly asks for tsconfig inspection |
| Why not TS 7.x | pinned to the **stable 5.9.x** line | TS 7 (native port) is very new; no benefit here, higher tooling risk |
| Runtime dependencies | **ZERO** | no HTTP framework (`node:http`), no validation library (explicit validators), no DB driver (`node:sqlite`). Minimises supply-chain surface for the component that holds credentials |
| HTTP | global `fetch` + `AbortSignal.timeout` | Node 24 built-in with an explicit timeout. **Separate connect/read timeouts are not available through `fetch`** — documented honestly as a single overall timeout |
| Ledger storage | `node:sqlite` (synchronous, transactional) | Q6 permits SQLite; zero dependency, real transactions, atomic `ON CONFLICT` claim |
| Gateway server | `node:http` | one narrow private route; a framework would add attack surface without benefit |
| Tests | `node:test` + `node:assert/strict` | zero dependency; consistent with Alveron's own node-native approach |
| Lint/format | **TypeScript `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters` instead of ESLint/Prettier** | avoids tooling that largely duplicates the typechecker at this stage. A conscious, documented limitation |

Dev dependencies: `typescript@5.9.3`, `@types/node@^24.13.5`. Runtime dependencies: none.

---

## 3. Architecture

```text
                        ALVERON (source of truth)
                             │  confirmed API only
                             ▼
   src/integrations/alveron/   (config · errors · logger · rate-limiter · http · auth · schemas · normalization · client)
                             │
                             ▼
   src/services/paid-order-discovery.ts   +   src/workflows/paid-order-confirmation.ts
                             │
                   ┌─────────┴─────────┐
                   ▼                   ▼
             src/ledger/        src/providers/email/
                   └─────────┬─────────┘
                             ▼
                   src/gateway/  (node:http, GATEWAY_API_KEY, private)
                             │
                             ▼
                          n8n   (Schedule Trigger → HTTP Request)
```

**Credential ownership (enforced by design):** Alveron service credentials exist only inside the gateway process; n8n holds only `GATEWAY_API_KEY`; the Alveron bearer token is never returned by any gateway response.

---

## 4. Modules to create

| Path | Responsibility |
|---|---|
| `src/integrations/alveron/config.ts` | central env parsing + fail-fast validation |
| `src/integrations/alveron/errors.ts` | error taxonomy (`ConfigError`, `AuthError`, `HttpError`, `ValidationError`, `RateLimitError`, `EmailProviderError`, `LedgerError`) + retryability |
| `src/integrations/alveron/logger.ts` | structured JSON logs + redaction (never tokens/passwords/keys) |
| `src/integrations/alveron/rate-limiter.ts` | explicit rolling-window limiter (ceiling deliberately below Alveron's 60/min) |
| `src/integrations/alveron/http.ts` | timeout, explicit retry/backoff, 429 + `Retry-After`, redacted diagnostics |
| `src/integrations/alveron/auth.ts` | session manager: authenticate, cache, expiry tracking, single-flight re-auth, fail closed |
| `src/integrations/alveron/schemas.ts` | explicit validators for session / Order / OrderItem / Payment |
| `src/integrations/alveron/normalization.ts` | documented normalization (`SUCCESS`/`paid` → internal `PAID`), originals preserved for diagnostics |
| `src/integrations/alveron/client.ts` | typed **read-only** methods: `getOrders()`, `getOrder(id)` |
| `src/integrations/alveron/index.ts` | public surface of the integration layer |
| `src/services/paid-order-discovery.ts` | paid-order candidate discovery from `GET /orders` |
| `src/workflows/paid-order-confirmation.ts` | Workflow 1 orchestration: claim → detail → validate → notify → ledger |
| `src/ledger/{types,sqlite-ledger,index}.ts` | storage-agnostic `Ledger` interface + SQLite implementation |
| `src/providers/email/{types,templates,console-provider,unconfigured-provider,index}.ts` | provider abstraction, dev adapter, fail-closed default, message content |
| `src/gateway/{server,routes,start,index}.ts` | private HTTP boundary, API-key auth, sanitized responses, run ids |
| `tests/**` | unit, contract (fixtures), security |
| `scripts/{verify-env,check-alveron-connectivity}.ts` + `scripts/{export,import}-workflows.mjs` | configuration/connectivity tooling + n8n workflow sync |
| `n8n/workflows/*.json`, `n8n/templates/*.json` | Workflow 1, error workflow, skeleton (no secrets) |
| `.env.example`, `README.md`, `tsconfig.json`, `package.json`, `.gitignore` | project scaffolding |

## 5. Configuration and authentication

Environment only: ALVERON_API_BASE_URL, ALVERON_SERVICE_EMAIL, ALVERON_SERVICE_PASSWORD, GATEWAY_API_KEY, FEATURE_ENABLE_ALVERON_WRITES=false, EMAIL_PROVIDER=unknown|console, ADMIN_ALERT_EMAIL, LOG_LEVEL, LEDGER_DATABASE_URL, NODE_ENV. Development loopback API/gateway only; production startup rejected. Optional timeout/retry controls are bounded. No Supabase credential/configuration is needed.

POST /auth/admin-login is the only authentication endpoint. Cache expiry from session metadata; single-flight re-authentication through that same endpoint, never direct Supabase refresh. No guessed token lifetime. Validate profile admin + active employee with role slug admin and matching user identities. No account creation.

## 6. Gateway, workflow and provider

One authenticated POST /internal/workflows/paid-order-confirmation/run with empty JSON object; GET /internal/health is authenticated local liveness only. No proxy or writes. Constant-time gateway key verification, bounded request body, no external redirects, sanitized responses.

Discovery reads GET /orders (no invented pagination); paid candidates require fresh GET /orders/:id validation. Missing email fails closed. Customer and admin notifications have separate ledger keys so admin failure cannot resend customer confirmation. Provider interface is independent of Alveron; console logs sanitized metadata, explicitly simulated, isolated by provider namespace. Unknown provider rejects sends.

## 7. Ledger and revised safety decisions

SQLite uses a PRIMARY KEY and single-statement conditional upsert for atomic claims, plus owner fencing on completion. States PENDING/SUCCESS/FAILED, bounded attempts, timestamps and provider identifier; no customer payload. Definite non-delivery may retry. Unknown send outcomes and crashes remain PENDING for manual reconciliation, never automatic stale reclamation. No automatic retention deletion while full-history polling can rediscover old orders. Exactly-once external delivery cannot be guaranteed without provider idempotency/reconciliation; prefer blocked work over duplicate sends.

## 8. Testing and verification

Node-native tests: config, auth lifecycle, timeout/429/5xx/nonretryable status, schemas, missing email, SQLite persistence/concurrency, send failure, duplicate restart, gateway key/body/proxy rejection, response/log sanitization. Contract fixtures are synthetic documented shapes, not recorded production responses. Live dev is opt-in and requires an owner-provisioned account and real paid order; absent those, report NOT RUN. Never manufacture orders. Run build/typecheck/tests; add justified formatter/linter tooling rather than claim nonexistent checks.

## 9. Known limitations / unresolved decisions

Preserve G-1 through G-13 and documented discrepancies in INTEGRATION_ANALYSIS.md. In particular full-list polling may be truncated by upstream database limits; no completeness guarantee, no outbound event stream. Provider/domain, real dev account, live paid order, and production URL remain UNKNOWN. No referral workflow. Phase-1 analysis incorrectly claims repeated order status writes always fail: they may repeat side effects; no writes are implemented. It also suggests pending-to-paid admin testing, which the transition map does not allow: do not use that fallback.

## 10. Expected files

Create modules listed in section 4 as needed (combine small modules rather than empty scaffolding), tests/unit, tests/contract, tests/security, scripts verification/connectivity/n8n configuration, n8n/workflows and explanatory templates/data-tables READMEs, .env.example and README.md. Update package.json, package-lock.json, tsconfig.json and .gitignore. Add docs/PHASE_4_IMPLEMENTATION.md. Original four integration documents remain unmodified; this plan and Phase-4 report record superseding safety decisions. No Alveron files change.
