# Live Alveron API — Connection Requirements Determination

**Date:** 2026-09-20 · **Scope:** determine exactly what is required to connect the automation gateway to the live Alveron API at `https://api.alveronfashion.com/api`. **Nothing was deployed, created, modified, or written to production.** Read-only probes only.
**Labels:** CONFIRMED (probed live / verified in source) · PROPOSED · UNKNOWN · BLOCKED.

---

## 1. Repository inspection

| Item | Result |
|---|---|
| `https://github.com/norbert351/alveron` | **404 via the public GitHub API and HTML** → the repository is private (or renamed). Public inspection is impossible; its remote is **UNKNOWN** for this machine. |
| Authoritative inspection source | the local mirror at `C:\dev\alveron` (`apps/api`, `apps/web`, `supabase/migrations/001–016`), matching the structure documented in `docs/ALVERON_API.md` / `_DATABASE.md` / `_EVENTS.md`. |
| Deployment artifacts in the repo | **None found**: no pm2 `ecosystem.config.js`, no Dockerfile/compose, no nginx config, no deploy scripts. Only `apps/api/api-prod.log` / `api-dev.log` and `apps/api/package.json` → `"start:prod": "node dist/main"`. |
| Consequence | **How the API process is supervised on the VPS (pm2? systemd? bare node?) is UNKNOWN.** The operator must confirm before the gateway is co-located on that host. |

## 2. Live API verification (CONFIRMED — read-only probes, 2026-09-20)

| Probe | Result | Production side effect |
|---|---|---|
| `GET /api/products` | **HTTP 200**, JSON, 3.7 KB | none (public read) |
| `GET /api/settings/store` | **HTTP 200**, JSON | none (public read) |
| `GET /api/orders` (no token) | **HTTP 401** | **none** — `AuthGuard` rejects a missing token before any DB call |
| `GET /api/referrals/admin/stats` (no token) | **HTTP 401** | **none** (same reason) |
| `GET /api/orders/:uuid` (no token) | **HTTP 401** | **none** |
| `POST /api/auth/admin-login` with `{}` | **HTTP 400** (global `ValidationPipe`: missing `email`/`password`) | **none** — validation rejects **before** the service runs, so no `login_events` row was written. The endpoint exists and is validation-guarded. |
| `GET /api` (root) | **HTTP 404** | none |
| TLS | `CN=api.alveronfashion.com`, issuer **Let's Encrypt**, **notAfter 2026-12-07** | — |
| Front proxy | `Server: nginx/1.24.0 (Ubuntu)`; `X-Powered-By` absent (helmet active) | — |

Conclusions: `https://api.alveronfashion.com/api` is **live and correct** (resolving the G-10 UNKNOWN for the *production* environment), admin surfaces are closed to unauthenticated callers, and **no production data was created or modified** by these probes.

## 3. Credentials required (exact names — values never handled or requested here)

| Credential | Required by | Where it must live | Owner / how it is created |
|---|---|---|---|
| `ALVERON_SERVICE_EMAIL` | gateway (`POST /auth/admin-login`) | gateway env file on the VPS (e.g. `deploy/gateway.env`, mode 600) + nowhere else | **Alveron owner creates a dedicated Supabase Auth user** — NOT a personal admin account |
| `ALVERON_SERVICE_PASSWORD` | gateway (same) | same env file | same; rotate without touching workflows |
| `GATEWAY_API_KEY` | n8n → gateway (`x-gateway-key` header) | gateway env file **and** an n8n **Header Auth** credential | operator generates (≥32 random chars); never in workflow JSON or Git |
| `ADMIN_ALERT_EMAIL` | gateway (admin alerts) | gateway env file | operator chooses an internal mailbox |
| `LEDGER_DATABASE_URL` | gateway (SQLite ledger) | gateway env file, e.g. `sqlite:/opt/alveron-automation/data/ledger.sqlite` | operator; directory writable by the service user and backed up |
| `EMAIL_PROVIDER` | gateway | gateway env file | `unknown` (fail-closed) or `console` until a real provider is approved (Q4) |

**Explicitly NOT required by the automation** (and must stay out of n8n and this repository): Supabase **service-role** key, Supabase anon/publishable key, Paystack secret key, any database password, any Alveron JWT (tokens are obtained and cached only inside the gateway).

### Service-account requirements — from the verified guard chain (CONFIRMED)

The dedicated user must satisfy, simultaneously:

1. **`AuthGuard`** — a valid Supabase session (email + password login works).
2. **`RolesGuard` with `@Roles('admin')`** — `profiles.role='admin'`, **or** an employee whose RBAC role slug is exactly `admin`, **or** `is_super_admin`.
3. **`getOrderForUser` / `getOrderEvents` service-level re-check** — these read `profiles.role` directly and only accept `admin`/`staff`. ⇒ **`profiles.role='admin'` is mandatory regardless of the RBAC employee role.**
4. **`PermissionsGuard`** — not used by the four endpoints below, but `profiles.role='admin'` also yields `'*'`.
5. **`EmployeeGuard`** — requires an `employees` row with `status='active'`. Needed only for `/admin/notifications` (unused today) but **recommended** per the Q2 spec.
6. **`mustChangePassword` must be false** — `adminLogin` returns `mustChangePassword = !last_sign_in_at`, and the automation's auth manager **refuses** such a session. ⇒ **the account must complete at least one successful login before the gateway can use it** (the operator signs in once manually during provisioning). *(CONFIRMED in Alveron `auth.service.ts` and the automation's `auth.ts`.)*

Recommended provisioning shape (Q2): Supabase user → `profiles.role='admin'` → `employees` row (`status='active'`, RBAC role slug `admin`) → one manual sign-in → credentials into the gateway env file.

## 4. Endpoints required (exactly these; all others are off-limits)

| Endpoint | Guard (verified) | Used by | Production status |
|---|---|---|---|
| `POST /auth/admin-login` | none (validates admin/employee internally) | gateway session bootstrap | exists (400-validated probe) |
| `GET /orders` | `AuthGuard` + `@Roles('admin')` | paid-order discovery | 401 without token (correct) |
| `GET /orders/:id` | `AuthGuard` + ownership-or-`profiles.role admin/staff` | order validation | 401 without token (correct) |
| `GET /referrals/admin/stats` | `AuthGuard` + `@Roles('admin')` (+ invokes `processPendingReferrals()`) | referral qualification | 401 without token (correct) |

**Off-limits (Phase 4 §15.5):** order writes, Paystack endpoints, cart endpoints, support endpoints, refunds, customer/employee/role mutations, the legacy return flow, and `POST /orders/paystack/webhook` (Paystack-only).

## 5. VPS configuration required (determination only — nothing applied)

The API is deployed at `/var/www/alveron`, fronted by **nginx 1.24.0 (Ubuntu)** with Let's Encrypt TLS
(cert for `api.alveronfashion.com` expires **2026-12-07** — confirm auto-renewal).

| Requirement | Determination |
|---|---|
| **Gateway host** | **PROPOSED:** run the gateway on the **same VPS** as the API, bound to `127.0.0.1:8787`, so n8n reaches it privately and nothing new is exposed. Alternative (separate host) requires relaxing the loopback guard — see §6. |
| **n8n host** | same VPS (or the automation host), reached publicly only as `n8n.alveronfashion.com` behind nginx with TLS; compose file and nginx template already prepared in `deploy/`. |
| **DNS** | new `A/AAAA` record for `n8n.alveronfashion.com` → the VPS IP; a new Let's Encrypt certificate for that name (certbot). **Operator action; not performed.** |
| **Firewall** | public: 80/443 only (already in place for the storefront/API). Loopback-only: gateway `8787`, n8n `5678`. **No new inbound rule is required** if both run on the VPS. |
| **Node.js version** | the gateway requires **Node ≥ 22.5** (built-in `node:sqlite`). The VPS Node version is **UNKNOWN** — the operator must run `node --version`; if < 22.5, install Node 22 LTS (nvm/nodesource) *without touching the Alveron app's runtime*, or containerise the gateway. **BLOCKED on this check.** |
| **Automation repo on the VPS** | clone/pull to e.g. `/opt/alveron-automation` from the **private remote** (the public GitHub URL 404s); `npm ci && npm run build` (TypeScript is a dev dependency, the gateway runs `dist/`). |
| **Process supervision** | systemd unit template already in `deploy/OPERATOR_RUNBOOK.md` (`alveron-gateway.service`: dedicated user, `EnvironmentFile`, `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` for the ledger directory). |
| **Ledger** | `LEDGER_DATABASE_URL=sqlite:/opt/alveron-automation/data/ledger.sqlite` — writable directory, included in backups; contains only automation-run state, never customer data. |
| **Rate-limit budget** | Alveron enforces **60 req/min per source IP**. If the gateway shares the VPS egress IP with other clients, the budget is shared; the gateway serialises to ≤ 40/min by configuration. |
| **Secrets at rest** | `deploy/gateway.env` mode 600, owned by the service user; never in Git; `N8N_ENCRYPTION_KEY` backed up separately. |
| **Alveron API supervision** | **UNKNOWN** (no deploy artifacts in the repo). Confirm what supervises `apps/api` (`start:prod` = `node dist/main`) so gateway restarts are independent of API restarts. |
| **Paystack raw-body preservation** | relevant to Alveron's webhook, not the automation — **UNKNOWN** whether the production nginx preserves the raw body; flag for the Alveron owners. |

## 6. Implemented repository-side production guard

`src/integrations/alveron/config.ts` now keeps loopback as the default and accepts a remote base URL only when
both conditions hold:

- the scheme is `https://` (plain-HTTP remote URLs are refused), and
- `ALVERON_ALLOW_REMOTE_API=true` is explicitly set.

`NODE_ENV=production` is accepted, but production mode rejects the simulated console email provider. The client
still exposes only the allow-listed read endpoints plus the login POST, and `FEATURE_ENABLE_ALVERON_WRITES` must
remain `false` in every mode. Unit tests cover remote HTTP rejection, HTTPS without opt-in, HTTPS with opt-in,
production mode, and write refusal.

**Current operator boundary:** remote HTTPS support does not by itself authorize or complete a production launch.
The service account, VPS checks, real email adapter, n8n credential binding, controlled tests, and explicit
operator approval remain required.

## 7. Operator checklist to connect the gateway to the live API

```
[ ] 1. Confirm VPS Node >= 22.5 (node --version)          [ ] if not, install Node 22 LTS for the gateway
[ ] 2. Confirm how apps/api is supervised (pm2/systemd)   [ ] so gateway restarts are independent
[ ] 3. Create the dedicated service account               [ ] profiles.role='admin' + active employee (slug 'admin')
[ ] 4. Sign in once manually with that account            [ ] clears mustChangePassword
[ ] 5. Review the implemented §6 config guard            [ ] remote HTTPS still requires explicit opt-in
[ ] 6. Deploy the automation repo to the VPS              [ ] /opt/alveron-automation, build dist/
[ ] 7. Create deploy/gateway.env (mode 600)               [ ] ALVERON_API_BASE_URL=https://api.alveronfashion.com/api
                                                          [ ] ALVERON_ALLOW_REMOTE_API=true
                                                          [ ] service email/password, GATEWAY_API_KEY,
                                                          [ ] ADMIN_ALERT_EMAIL, LEDGER_DATABASE_URL,
                                                          [ ] EMAIL_PROVIDER=unknown, FEATURE_ENABLE_ALVERON_WRITES=false
[ ] 8. systemd: enable alveron-gateway                    [ ] systemctl status alveron-gateway
[ ] 9. npm run build; then run `node --env-file=deploy/gateway.env dist/scripts/verify-env.js`
[ ]    and `node --env-file=deploy/gateway.env dist/scripts/check-alveron-connectivity.js` (successful admin login + authorized read)
[ ] 10. n8n: DNS + TLS for n8n.alveronfashion.com         [ ] compose up, import 3 workflows, Header Auth credential,
                                                          [ ] bind error workflow, keep everything INACTIVE
[ ] 11. Live referral test data (dev-like) approved       [ ] or keep the referral workflow inactive
[ ] 12. Operator approval to activate schedules
```

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | The service account is admin-equivalent (G-4) | dedicated account, revocable (deactivate employee row / rotate password), visible in `login_events`/`admin_logs` |
| R2 | The production base URL is now known — temptation to bypass the gateway | the client remains allow-listed to 4 endpoints; write methods do not exist |
| R3 | Remote-URL opt-in weakens the dev guard | https-only + explicit opt-in + tests (§6) |
| R4 | Shared egress IP rate budget | gateway serialises ≤ 40/min; single-flight auth |
| R5 | TLS cert expiry 2026-12-07 | confirm certbot auto-renewal on the VPS (operator) |
| R6 | `mustChangePassword` blocks the automation silently | provisioning step 4 (one manual sign-in); the auth manager fails closed with a clear category |
| R7 | Alveron swallows referral-processing errors (V5) | automation reports `sideEffectInvoked` and `processedCount: null`; never claims success |

## 9. Summary

| Question | Answer |
|---|---|
| Credentials required | dedicated Supabase service account (email+password) with `profiles.role='admin'`, active employee (RBAC slug `admin`), **one manual sign-in**; plus operator-generated `GATEWAY_API_KEY`, `ADMIN_ALERT_EMAIL`, `LEDGER_DATABASE_URL` |
| Permissions required | `@Roles('admin')` **and** `profiles.role='admin'` (service-level re-checks) — no Supabase service-role key, no Paystack secret, no DB credential |
| Endpoints required | `POST /auth/admin-login`, `GET /orders`, `GET /orders/:id`, `GET /referrals/admin/stats` — all CONFIRMED live; admin reads correctly 401 unauthenticated |
| VPS configuration required | gateway as a private loopback systemd service on the API host (Node ≥ 22.5 — **must be verified**), n8n behind nginx with a new DNS record + TLS, firewall unchanged, ledger path + backups, automation repo cloned/built to `/opt/alveron-automation` |
| Repository-side change | HTTPS remote opt-in is implemented and unit-tested (§6); operator launch approval and remaining deployment prerequisites are still required |
| Status | **BLOCKED** on: service account, VPS Node version check, real email adapter, n8n runtime/credential binding, and approved live test data |