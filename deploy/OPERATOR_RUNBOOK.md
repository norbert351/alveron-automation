# Alveron Automation — Operator Runbook (self-hosted n8n + private gateway)

This repository never deploys or touches infrastructure. Everything below is **executed by the operator**.
Secrets come from the operator's secret manager and are **never committed**.

## 0. Version

n8n **2.39.8** (stable, verified 2026-09-18 against the official repository). Re-check the official
releases page before deploying; never use `latest`/`next`/beta/nightly.

## 1. Development runtime verification (this machine)

Already performed in Phase 6 where marked; the commands are reproducible:

```powershell
# 1. pinned n8n runtime (local, git-ignored folder)
Set-Location C:\dev\alveron_n8n\.n8n-runtime
npm install n8n@2.39.8 --no-audit --no-fund

# 2. configuration (names only; values from your secret store)
$env:N8N_USER_FOLDER   = 'C:\dev\alveron_n8n\.n8n-state'
$env:N8N_ENCRYPTION_KEY = '<strong random secret>'      # stable across restarts; never commit
$env:N8N_SECURE_COOKIE  = 'false'                        # local http only
# GATEWAY_BASE_URL is no longer consumed via $env; the workflow JSON pins http://127.0.0.1:8787.
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_TEMPLATES_ENABLED   = 'false'
npx n8n start                                            # binds 5678 (loopback)

# 3. gateway (separate terminal) — needs a real ALVERON_API_BASE_URL + service account for LIVE runs
Set-Location C:\dev\alveron_n8n
$env:ALVERON_API_BASE_URL = '<operator-supplied dev url>/api'
$env:ALVERON_SERVICE_EMAIL = '...'; $env:ALVERON_SERVICE_PASSWORD = '...'
$env:GATEWAY_API_KEY = '<>=32 chars>'; $env:ADMIN_ALERT_EMAIL = '...'
$env:LEDGER_DATABASE_URL = 'sqlite:./data/ledger.sqlite'; $env:EMAIL_PROVIDER = 'console'
npm run verify:env ; npm run gateway

# 4. mock Alveron (ONLY if live Alveron is not yet available)
node scripts/mock-alveron.mjs 4600
```

## 2. Production deployment (VPS: 95.111.239.180)

Repository checkout that is already present: `/var/www/alveron-automation`. Build once, run host-only:

```bash
cd /var/www/alveron-automation
npm ci && npm run build && npm test
cp deploy/.env.example deploy/.env            # then fill values from the secret manager; chmod 600
cp deploy/gateway.env.example deploy/gateway.env  # fill required service/admin secrets; keep Telegram disabled initially; chmod 600
```

n8n (Docker) + Postgres (Docker) via `deploy/docker-compose.yml`:

- `n8n` uses `network_mode: host`, binds `127.0.0.1:5678` (`N8N_LISTEN_ADDRESS`), pinned
  `n8nio/n8n:2.39.8`. Host networking lets n8n reach the host-private gateway at `127.0.0.1:8787`.
- `postgres` (n8n's database) runs in a bridge network, published ONLY to the host loopback
  as `127.0.0.1:5432:5432` — never reachable from the Internet.
- Secrets come from `deploy/.env`: `N8N_ENCRYPTION_KEY` (back it up), `POSTGRES_*` database
  credentials, runtime tuning. Non-secret `GATEWAY_BASE_URL` is NOT needed anymore — the workflow
  JSON pins `http://127.0.0.1:8787`.

```bash
cd /var/www/alveron-automation/deploy
docker compose pull
docker compose up -d          # n8n on 127.0.0.1:5678 (named volumes n8n_storage + n8n_postgres_data)
curl -sf http://127.0.0.1:5678/healthz   # then https://n8n.alveronfashion.com/healthz (nginx TLS)
```

TLS terminates on the host nginx (`/etc/nginx/sites-enabled/alveron-n8n`, Let's Encrypt).

The gateway runs as a host systemd service (private, loopback) under the `alveron` system user:

```ini
# /etc/systemd/system/alveron-automation-gateway.service
[Unit]
Description=Alveron Automation Gateway (private)
After=network-online.target
[Service]
Type=simple
User=alveron
WorkingDirectory=/var/www/alveron-automation
EnvironmentFile=/var/www/alveron-automation/deploy/gateway.env
ExecStart=/usr/bin/node dist/src/gateway/start.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/www/alveron-automation/data
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now alveron-automation-gateway
sudo systemctl status alveron-automation-gateway
```

The gateway binds `127.0.0.1:8787` only. n8n reaches it via the shared host loopback. Run exactly one gateway
instance: its in-process Telegram queue and rate limiter are intentionally scoped to that instance.
**Never** expose 3000/4000/5678/5432/8787 to the Internet; only n8n behind nginx is public.

## 3. Workflow import, credential and activation gate

1. Import the workflow JSON files (`n8n/workflows/*.json`) via the n8n editor or
   `npm run n8n:import` (`node scripts/import-workflows.mjs`), which validates the bindings first and
   then imports with `--activeState=false` (imports always arrive **inactive**).
2. The error-workflow binding is encoded, not manual: every workflow pins a stable `id` and
   `settings.errorWorkflow` points at `Alveron Automation — Error Classification (DEV)`
   (`T0o2hhdklxob9bkX`). Verify with `npm run validate:workflows`. A fresh import therefore
   reproduces the relationship; do not hand-edit the live n8n database.
3. Create one **Header Auth** credential: header `x-gateway-key`, value = `GATEWAY_API_KEY` from the secret
   store. Select it in every `Run Private Gateway` node and in `Request Telegram Admin Alert`. The key must
   never appear in workflow JSON.
4. `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` on the instance: workflow code can never read the process
   environment, so container secrets stay out of reach. The gateway URL is pinned in each workflow
   HTTP Request node (`http://127.0.0.1:8787`, non-secret, host-local).
5. Configure the schedules with `node scripts/configure-workflow.mjs` before import (reads
   `PAID_ORDER_POLL_MINUTES`, `REFERRAL_QUALIFICATION_POLL_MINUTES`, `PRODUCT_REQUEST_POLL_MINUTES`,
   `LOW_STOCK_POLL_MINUTES`, `ORDER_OPERATIONS_POLL_MINUTES`, `PAYMENT_RECONCILIATION_POLL_MINUTES`,
   `SHIPPING_SLA_POLL_MINUTES`, `SYSTEM_HEALTH_POLL_MINUTES` and the eight `FINANCE_*_POLL_MINUTES`
   (including `FINANCE_EVENTS_CONSUMER_POLL_MINUTES`); all remain inactive), or edit each Schedule
   Trigger directly. `SHIPPING_SLA_HOURS` (default 48) and the `FINANCE_*_THRESHOLD` values are
   gateway runtime configuration, not schedules. The finance workflows are fail-closed: if Alveron
   returns 404/5xx for a contract endpoint in `docs/FINANCE_API_CONTRACT.md`, expect a CRITICAL
   `FINANCE_UNAVAILABLE` alert, then no financial numbers. The `finance-events-consumer` workflow
   drains the `finance_events` outbox over the typed read/ack contract and only acknowledges an event
   after its notification succeeds; keep it inactive until the operator approves activation.
6. **Leave all workflows inactive** until the operator explicitly approves activation.
7. Set n8n owner + MFA; enable 2FA for all users if mandated.

## 4. Activation gate (all boxes required before publishing)

[ ] n8n 2.39.8 pinned · [ ] persistent storage (`n8n_storage` volume / real user folder) ·
[ ] `N8N_ENCRYPTION_KEY` set and backed up · [ ] owner account + MFA · [ ] gateway API key configured ·
[ ] Alveron service account exists (`profiles.role='admin'` + active employee, RBAC slug `admin`) ·
[ ] `ALVERON_API_BASE_URL` confirmed for the target environment · [ ] secrets outside Git ·
[ ] workflows imported and **inactive** · [ ] error workflow bound · [ ] gateway reachable only privately ·
[ ] `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (no secret env reachable from workflows) ·
[ ] no Telegram/Alveron/Paystack/DB secrets in n8n · [ ] dev integration verified (Phase 6 results) ·
[ ] Telegram credential and controlled-delivery checks passed when enabled · [ ] restart tests passed ·
[ ] `EMAIL_PROVIDER=resend` with a verified Resend sender, **or** `EMAIL_PROVIDER=unknown` accepted as
fail-closed · [ ] `ALVERON_AUTOMATION_MODE` set deliberately (`live` only when email delivery is approved) ·
[ ] **operator approval to activate**.

### Finance activation gate (all eight finance workflows)

Confirmed programmatically/read-only during finalization: Telegram provider `telegram` (token/chat
valid), `GATEWAY_API_KEY` present (54 chars, loopback), n8n Header Auth `x-gateway-key` matches the
gateway key, `FINANCE_TIMEZONE=Africa/Lagos`, all `FINANCE_*_THRESHOLD=0` (disabled), service account
auth + `finance:view` RBAC pass, and the live read-only finance contract (8 endpoints + outbox)
passes. Remaining operator actions:

[ ] **Import/refresh the workflows** with `npm run n8n:import` — the binding is encoded in the JSON
    (stable ids + `settings.errorWorkflow`), so no manual Settings → Error Workflow step is required.
[ ] **Restart `alveron-automation-gateway`** so the running process loads the current `dist/` (the
    live process predates the finance code and returns 404 for all finance routes). No new code is
    deployed — this reloads already-built artifacts.
[ ] Confirm each workflow is bound to `Alveron Automation — Error Classification (DEV)`
    (`T0o2hhdklxob9bkX`) and remains **inactive** after import.
[ ] Review the finance threshold table (§7) and decide whether any signal should be enabled.
[ ] Optional controlled Telegram test passed (`🧪 ALVERON TELEGRAM TEST` delivered).
[ ] **Operator approval to activate.**

### Activation mechanism (manual, per workflow)

Nothing in this repository or its deployment activates a workflow. `configure-workflow.mjs` forces
`active:false`, `import:workflow` defaults to `--activeState=false`, and `docker compose up`,
`restart`, and gateway restarts do not publish. The only way to activate is the explicit operator
command below, one approved workflow at a time:

```bash
docker exec alveron-n8n n8n list:workflow                         # confirm ids + inactive state
docker exec alveron-n8n n8n publish:workflow --id=<workflow-id>   # activate ONE approved workflow
docker exec alveron-n8n n8n unpublish:workflow --id=<workflow-id> # deactivate again
```

Publish the shared error workflow (`T0o2hhdklxob9bkX`) so it is **active**. n8n 2.39.8 refuses to
execute an inactive error workflow (`Calling Error Workflow ... Workflow "T0o2hhdklxob9bkX" is not
active and cannot be executed`), so failures stay unclassified until it is published. It contains
only an Error Trigger (`errorTrigger`), so publishing adds no schedule — it fires only when another
workflow fails:

```bash
docker exec alveron-n8n n8n publish:workflow --id=T0o2hhdklxob9bkX   # activate the error workflow
```

## 5. Telegram admin notifications

The gateway owns Telegram delivery through the official HTTPS `sendMessage` API. n8n never receives the bot
token or admin chat ID. Keep these values only in the ignored `deploy/gateway.env` secret file with mode
`600`, under the `alveron` system user:

- `TELEGRAM_PROVIDER`: change from `disabled` to `telegram` only after both credential values are present.
- `TELEGRAM_BOT_TOKEN`: Bot API token; never log, print, export, or place in n8n.
- `TELEGRAM_ADMIN_CHAT_ID`: trusted destination selected by the operator; callers cannot override it.
- `TELEGRAM_TIMEOUT_MS`: full Telegram request deadline, default `10000`, allowed range `1000`–`30000`.

> **Bot ID is not the chat ID.** A Bot API token is `<bot_id>:<secret>` — for example a token beginning
> `8714048677:` carries bot ID `8714048677`, which is the bot's own identity and **cannot** be used as a
> destination. The admin chat ID is the operator's numeric **user** ID (a positive number, visible via
> `getMe`/`getUpdates` or a `@userinfobot`), or an `@channelusername` you deliberately accept broadcasting to.
> Verify a candidate before wiring it in: `getChat?chat_id=<id>` returning `"type":"private"` for a DM confirms
> it is a real, reachable chat, and it only succeeds once the operator has sent `/start` to the bot at least once.

Do not set only one credential: disabled mode requires both values absent, and enabled mode requires both.
Validate configuration without printing secret values, restart the single gateway instance, then run the
controlled live command exactly once:

```bash
npm run build
node --env-file=deploy/gateway.env dist/scripts/verify-env.js
sudo systemctl restart alveron-automation-gateway
node --env-file=deploy/gateway.env dist/scripts/test-telegram.js
```

Using Node's `--env-file` loads the ignored systemd environment file without printing values or placing them in
command arguments. `npm run test:telegram` remains available only when the same variables are already exported
into the current process. The controlled test checks loopback gateway/n8n health and sends one real provider test
message. It is not part of `npm test`; all automated tests use an injected mock and never contact Telegram. The
command prints only status, scope, environment, and health metadata.

Implemented alerts are: paid order, current `VERIFICATION_FAILED` payment state, referral-processing trigger,
sanitized automation error, new product-sourcing request, low stock, out of stock, operational order-status
transitions, payment-reconciliation anomalies, shipping-SLA delays, automation system health, and the controlled
test. All are read-only observations except the controlled test; none mutates Alveron.

**Correction (Telegram integration pass).** An earlier revision of this runbook stated that product-request
alerts were "intentionally absent because the current Alveron interface provides no reliable event or
inventory source". That was wrong on both counts and has been corrected:

- `GET /admin/product-requests` **does** exist and is reachable with the existing admin service account. It
  returns `{ items, page, pageSize, total }`. The endpoint postdates the Alveron reference documentation in
  `docs/`, which is why the earlier pass missed it. It returned zero rows when probed, so the row schema
  could not be observed directly.
- Low stock **is** reliably derivable. `GET /products` returns each product's `low_stock_alert` and
  `track_inventory` alongside `variants[].stock`, so the previously open gap N4 ("variant coverage unverified")
  is resolved. This closes gap N4 in `docs/INTEGRATION_ANALYSIS.md` §16.6.

Because the product-request row schema is unverified, its parser is deliberately **tolerant on display fields
and strict on identity**: `id` (else `reference`) is required because it is the idempotency key, and every
customer-facing field is omitted when absent rather than guessed. Reference images are never attached — they
live in a private bucket and this architecture cannot mint a signed URL — so the alert carries the request
reference and directs the admin to the dashboard. If the live schema differs from the alias list in
`src/integrations/alveron/product-requests.ts`, add the real field name there; nothing else needs to change.

The optional **daily summary is still NOT IMPLEMENTED**, for a measured reason rather than an assumed one.
`GET /admin/stats` exposes only lifetime totals (`totalOrders`, `totalRevenue`) and `GET /admin/analytics`
exposes `dailyOrders` / `dailyRevenue` as a time series. Per-day values for paid orders, pending payments and
qualified referrals are therefore not obtainable: the referral figures come from lifetime aggregates on
`/referrals/admin/stats`, and deriving daily counts would require the full-list order scan already recorded as
open gap G-1. Rather than publish a summary whose labels imply a day while the numbers are lifetime totals, or
add broad read access to close the gap, the limitation is reported here. Two orders, not the gateway, raise
`GATEWAY_API_KEY`; the summary will need a decision on `G-1` first.

Delivery is serialized at one message per 1.1 seconds and conservatively capped at 20 per minute. SQLite keys
include a destination hash and are durable across restart. A confirmed non-delivery is retryable; an ambiguous
transport result remains `PENDING` and is not automatically resent, because Telegram has no idempotency key.
Inspect the notification ledger before any manual reconciliation. Notification, ledger, and Telegram failures
never change the source-of-truth paid-order/referral outcome or customer-email result.

Both new pollers are additionally bounded so a large catalogue or a burst of requests cannot flood the admin
chat: at most 25 product-request alerts and 20 low-stock alerts per run, with the surplus reported as
`suppressedByCap` rather than dropped silently. Low-stock alerts are deduplicated per variant **and** per
observed stock level, so a variant that stays below its threshold alerts once and then stays quiet, while a
further drop to a new level alerts again.

To disable Telegram, set `TELEGRAM_PROVIDER` back to `disabled` and remove both Telegram credential values from
`gateway.env`, then restart the gateway. To rotate, replace both values during a controlled stop/restart, rerun
the one-message test, and never reuse the old token. The production configuration rejects the simulated console
email provider.

### Transactional email (Resend) and the customer-email safety mode

`EMAIL_PROVIDER=resend` enables the real server-side Resend adapter. It requires all of
`RESEND_API_KEY`, `RESEND_FROM_EMAIL` and (optionally) `RESEND_FROM_NAME` (default `Alveron Fashion`)
in the ignored, mode-`600` `gateway.env`. The key is never logged, returned, exported to n8n, or placed
in workflow JSON, and the sender domain must be verified in Resend before live activation. Until the
credentials and verified sender are supplied, the gateway stays fail-closed: `EMAIL_PROVIDER=unknown`
rejects every customer email rather than silently sending nothing.

`ALVERON_AUTOMATION_MODE` gates only the customer-facing confirmation:

- `live` — normal configured provider behavior.
- `test` — the customer confirmation is intercepted and simulated; Telegram/admin alerts still run.
- `disabled` — the customer confirmation is never sent.

The mode is part of the ledger namespace (`resend:test`, `resend:disabled`), so a simulated or
suppressed run can never occupy the live key and suppress a real send after the mode changes. Admin
(Telegram) delivery is unaffected by this variable — it is governed solely by `TELEGRAM_PROVIDER`.

Order discovery uses bounded `GET /orders?limit=&offset=` pagination (`ALVERON_ORDER_PAGE_SIZE`,
`ALVERON_ORDER_MAX_PAGES`), deduplicated by order id; the previous full-list scan (gap G-1) is no
longer used.

### Automation outbox and operational workflows

The gateway exposes `/internal/workflows/automation-events/run` (drains Alveron's
`automation_events` outbox: product-request status changes and order-issue alerts) and
`/internal/workflows/daily-operations-summary/run` (one business-day digest). Both reuse the
existing ledger, admin (Telegram) provider and read-only client; neither mutates Alveron.

Alveron must grant the service account the `automation:view` / `automation:update` permissions for
the outbox read/ack contract (`GET /api/admin/automation/events`,
`POST /api/admin/automation/events/:id/ack`). The auto-acknowledge is the only non-financial write
the transport permits and it only flips an outbox row to `delivered`.

Poll intervals: `AUTOMATION_EVENTS_POLL_MINUTES` (default 15) and
`DAILY_OPERATIONS_POLL_MINUTES` (default 1440). The daily summary uses `FINANCE_TIMEZONE` for the
business date and is idempotent per date.

### Not implemented — blocked by the Alveron API

No workflow is created for these until Alveron exposes the data (doing so would fake production
readiness): referral customer notifications (needs a per-referral event/outbox or records),
abandoned-cart reminders (needs an authenticated, consent-aware cart inactivity API), customer
restock interest (needs a product/variant interest table with consent + unsubscribe), marketing
campaigns (needs consent/audience/unsubscribe + an approval store), and AI content / customer-service
intelligence (needs an AI provider and a human approval/publish gate). Returns/exchange customer
emails are already sent by Alveron, so automation only alerts the admin.

### Port 5679 is the n8n task broker, not a second instance

Only the production n8n container binds `127.0.0.1:5678`; the same `node /usr/local/bin/n8n` process
(PID inside the `alveron-n8n` container) also binds `127.0.0.1:5679` for n8n's internal task broker /
task runner used by Code nodes. It is not an obsolete second n8n, shares the container's cgroup, and
must **not** be stopped or removed. `docker exec alveron-n8n sh -c "ss -ltnp"` shows both ports owned
by the n8n process. The obsolete-instance finding was a false positive.

## 6. Restart drills (after first successful verification)

```bash
docker compose restart          # n8n + postgres: workflows, credentials, encryption key, history persist
sudo systemctl restart alveron-automation-gateway
```

Verify: workflows present and **inactive**; credential still decrypts (encryption key stable); execution
history as configured; gateway `/internal/health` OK; Alveron auth OK; ledger persists (duplicate suppression
still works for the same window); new windows still execute.

## 7. Incident notes

- The gateway is the only holder of Alveron credentials; rotate by changing the service-account password
  and `GATEWAY_API_KEY`, then restart both services (workflows untouched).
- Losing `N8N_ENCRYPTION_KEY` makes stored credentials undecryptable — back it up independently.
- If a referral run reports `failed`, do **not** blindly re-run: check the ledger window row and the
  failure category; Alveron's own processing is idempotent, so a bounded same-window retry is safe.