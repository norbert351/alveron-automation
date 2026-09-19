# Phase 6 Implementation Plan — Self-hosted n8n runtime + dev integration verification

**Status:** plan (before runtime work) · **Date:** 2026-09-18
**Scope:** take the existing Phase 4/5 implementation from "locally implemented and tested" to "running safely against a controlled environment through a real self-hosted n8n instance". **No new automations, no Alveron changes, no production deployment.**

---

## 1. Current state (verified before changing anything)

| Item | Verified state |
|---|---|
| Phase 4/5 implementation | complete; `npm test` = 49 tests (48 pass, 0 fail, 1 live skip); typecheck/build clean |
| Alveron integration | read-only; only `POST /auth/admin-login`, `GET /orders`, `GET /orders/:id`, `GET /referrals/admin/stats` |
| Gateway | loopback-only, `x-gateway-key` (constant-time), 2 workflow routes + health; no proxy routes |
| Ledger | gateway-owned SQLite; per-window claims; duplicate suppression proven in tests |
| n8n workflows | 3 JSON files, all `active:false`, credential-free |
| n8n runtime | **none** (no n8n CLI/package/instance; checked in Phases 4/5) |
| Docker | CLI 29.3.1 present, **daemon not running** (Docker Desktop engine pipe missing) |
| Live Alveron | `ALVERON_API_BASE_URL` **UNKNOWN** (G-10); no service-account credentials supplied (Q2) |

## 2. n8n version (re-verified against the official repository today)

| Candidate | Verdict |
|---|---|
| **n8n@2.39.8** | ✅ **stable, published 2026-09-18** — the pinned runtime for this phase |
| n8n@2.39.7 / 2.39.6 | superseded stable patch lines (2.39.6 was Phase 4's snapshot — outdated) |
| n8n@1.123.81 | older maintenance line — not used |
| n8n@2.40.x | **beta/pre-release — forbidden** |
| `latest` / `next` / `master` | forbidden |

Pin: `n8n@2.39.8` (npm) / `n8nio/n8n:2.39.8` (image digest pinned at deploy time by the operator).

## 3. Runtime topology decision

| Option | Assessment |
|---|---|
| **n8n via npm on the host (chosen for dev verification)** | n8n can reach the gateway on `127.0.0.1:8787`, so the gateway's **loopback-only** restriction is preserved. No new attack surface. |
| Docker Desktop n8n (rejected for this dev pass) | daemon not running; container→host-loopback networking would force the gateway onto a non-loopback interface, **weakening** the Phase 4 security model. Docker remains the **operator's** production path (templates provided). |
| n8n Cloud | forbidden (brief: self-hosted). |

## 4. What will be verified at runtime

1. **n8n runtime**: pinned version starts; persistent user folder; encryption key set; owner configured; workflows imported and **inactive**; gateway credential created and used by workflows (never in workflow JSON).
2. **Error workflow binding**: the imported error-handler's real instance ID is written into both workflow definitions' `settings.errorWorkflow` at import time (closes the Phase 4 "cannot pre-bind portably" gap).
3. **Gateway runtime**: starts from env; `/internal/health`; key enforcement; **ledger persistence across restart**; duplicate suppression across restart.
4. **End-to-end trigger**: real n8n execution → real gateway → controlled local **mock Alveron** (clearly labelled — §5) → sanitized result → duplicate suppression → error workflow on failure.
5. **Restart tests**: n8n restart (workflows/credentials/encryption key/history persist; inactive stays inactive) and gateway restart (auth works, ledger persists, suppression still works).

## 5. Honest boundary: mock Alveron vs live Alveron

`ALVERON_API_BASE_URL` is **UNKNOWN** (the brief forbids assuming `https://api.alveronfashion.com/api`) and no service-account credentials were supplied (Q2). Therefore **live Alveron integration is BLOCKED**, and this phase verifies the full runtime chain against a **local mock Alveron** (the same stub shape as the Phase 4/5 contract tests, run as a local process). Every result is labelled `MOCK` and is **not** a live Alveron result. Live verification is a single config change once the operator supplies the URL + service account.

## 6. Deliverables

| Path | Purpose |
|---|---|
| `docs/PHASE_6_IMPLEMENTATION_PLAN.md` | this plan |
| `docs/PHASE_6_IMPLEMENTATION.md` | runtime record: version, topology, env names, credential model, storage, test/restart/security results, blocked items |
| `deploy/docker-compose.yml` | operator's self-hosted n8n (pinned 2.39.8, named volume, env-file based secrets) |
| `deploy/nginx-n8n.conf.template` | reverse-proxy template for `n8n.alveronfashion.com` |
| `deploy/OPERATOR_RUNBOOK.md` | exact operator commands (dev + production), checklist, activation gate |
| `deploy/.env.example` | variable **names** only |
| `scripts/mock-alveron.mjs` | local mock Alveron for runtime verification (clearly labelled; **never** used for live data) |
| `scripts/runtime-verify.mjs` | automated runtime verification: gateway health/auth, referral duplicate suppression, paid-order duplicate suppression, ledger persistence |
| `.gitignore` | ignores `.n8n-runtime/`, `.n8n-state/`, runtime env files |

## 7. Non-goals (unchanged)

No new automations (WhatsApp/abandoned-cart/refunds/coupons/credits/AI/etc.), no Alveron code changes, no Paystack changes, no production deployment, no activation of production schedules, no real customer emails.

## 8. Risks

| Risk | Mitigation |
|---|---|
| npm install of n8n (large, native modules) may fail on Node 24/Windows | background install + polling; if it fails, document the exact Docker/npm commands and mark runtime BLOCKED |
| n8n headless owner/credential setup | use the documented owner-setup endpoint + CLI import; verify against the real instance, never assume |
| Local mock Alveron mistaken for live | explicit `MOCK` labelling in logs, script banner and docs |
| Config drift (15-min referral schedule vs 60-min window) | documented in §9 with the exact consequence |

## 9. Schedule/window alignment note (operator decision required)

Per the brief, the referral **schedule stays 15 minutes** while the **qualification window stays 60 minutes**. Consequence (CONFIRMED by the Phase 5 window logic): only ~1 in 4 scheduled triggers actually invokes Alveron — the other three return `duplicate`. Effective referral-processing frequency is therefore **once per hour**, not every 15 minutes. Options for the operator: (a) accept hourly processing, or (b) set `REFERRAL_QUALIFICATION_POLL_MINUTES=15` to match. This phase configures exactly as briefed (15-min schedule, 60-min window) and documents the drift rather than silently "fixing" it.