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
$env:GATEWAY_BASE_URL   = 'http://127.0.0.1:8787'        # non-secret, consumed via $env in workflows
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

## 2. Production deployment (operator; not executed from this repository)

```bash
# on the VPS, as a non-root user with Docker installed
cd /opt/alveron-automation/deploy        # checkout of this repository
cp .env.example .env                     # then fill values from the secret manager; chmod 600
docker compose pull
docker compose up -d                     # n8n on 127.0.0.1:5678 (named volume n8n_data)
# TLS via nginx template + certbot (see nginx-n8n.conf.template)
```

Gateway as a systemd service (private, loopback, same host or a private network segment):

```ini
# /etc/systemd/system/alveron-gateway.service
[Unit]
Description=Alveron Automation Gateway (private)
After=network-online.target
[Service]
Type=simple
User=alveron
WorkingDirectory=/opt/alveron-automation
EnvironmentFile=/opt/alveron-automation/deploy/gateway.env
ExecStart=/usr/bin/node dist/src/gateway/start.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/alveron-automation/data
[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now alveron-gateway
systemctl status alveron-gateway
```

The gateway binds `127.0.0.1:8787`; n8n reaches it only from the same host/private network.
**Never** expose 3000/4000/8787 to the Internet; only n8n behind nginx is public.

## 3. Workflow import, credential and activation gate

1. Import the three workflow JSON files (`n8n/workflows/*.json`) via the n8n editor or
   `n8n import:workflow --separate --input=n8n/workflows` (imports arrive **inactive**).
2. Set each workflow's **Error workflow** setting to the imported `error-handler` (real instance ID).
3. Create one **Header Auth** credential: header `x-gateway-key`, value = `GATEWAY_API_KEY` from the secret
   store. Select it in every `Run Private Gateway` node. The key must never appear in workflow JSON.
4. Set n8n's environment variable `GATEWAY_BASE_URL=http://127.0.0.1:8787` (non-secret) or configure the URL in the node.
5. Configure the schedules: `PAID_ORDER_POLL_MINUTES=15`, `REFERRAL_QUALIFICATION_POLL_MINUTES=60`
   (`node scripts/configure-workflow.mjs` before import, or edit the Schedule Triggers).
6. **Leave all workflows inactive** until the operator explicitly approves activation.
7. Set n8n owner + MFA; enable 2FA for all users if mandated.

## 4. Activation gate (all boxes required before publishing)

[ ] n8n 2.39.8 pinned · [ ] persistent storage (`n8n_data` volume / real user folder) ·
[ ] `N8N_ENCRYPTION_KEY` set and backed up · [ ] owner account + MFA · [ ] gateway API key configured ·
[ ] Alveron service account exists (`profiles.role='admin'` + active employee, RBAC slug `admin`) ·
[ ] `ALVERON_API_BASE_URL` confirmed for the target environment · [ ] secrets outside Git ·
[ ] workflows imported and **inactive** · [ ] error workflow bound · [ ] gateway reachable only privately ·
[ ] no Alveron/Paystack/DB secrets in n8n · [ ] dev integration verified (Phase 6 results) ·
[ ] restart tests passed · [ ] **operator approval to activate**.

## 5. Restart drills (after first successful verification)

```bash
docker compose restart          # n8n: workflows, credentials, encryption key, history persist
systemctl restart alveron-gateway
```

Verify: workflows present and **inactive**; credential still decrypts (encryption key stable); execution
history as configured; gateway `/internal/health` OK; Alveron auth OK; ledger persists (duplicate suppression
still works for the same window); new windows still execute.

## 6. Incident notes

- The gateway is the only holder of Alveron credentials; rotate by changing the service-account password
  and `GATEWAY_API_KEY`, then restart both services (workflows untouched).
- Losing `N8N_ENCRYPTION_KEY` makes stored credentials undecryptable — back it up independently.
- If a referral run reports `failed`, do **not** blindly re-run: check the ledger window row and the
  failure category; Alveron's own processing is idempotent, so a bounded same-window retry is safe.