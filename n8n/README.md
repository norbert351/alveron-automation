# n8n development setup — not deployed or runtime-verified

Use official n8n, not a fork. Every workflow JSON here is inactive and contains no credentials.

## Workflows in this repository (all inactive)

| File | Purpose | Schedule |
|---|---|---|
| `workflows/paid-order-confirmation.json` | Workflow 1: paid-order customer confirmation + admin alert | `PAID_ORDER_POLL_MINUTES` (default 15 min) |
| `workflows/referral-qualification.json` | Phase 5: triggers Alveron's own `processPendingReferrals()` via `GET /referrals/admin/stats` | `REFERRAL_QUALIFICATION_POLL_MINUTES` (default 1 hour) |
| `workflows/error-handler.json` | Shared Error Trigger: sanitized classification, transient/permanent flag, **no automatic replay** | n/a (bound per workflow in Settings) |

Both schedules are configured by `node scripts/configure-workflow.mjs` (reads
`PAID_ORDER_POLL_MINUTES` / `REFERRAL_QUALIFICATION_POLL_MINUTES`, clamps 5–1440, expresses
minutes ≤59, whole hours ≤23, or 1440 as one day, and always leaves `active:false`).

The referral workflow validates the sanitized gateway result, treats `duplicate` as a legitimate no-op
(HTTP 200), and throws `REFERRAL_QUALIFICATION_FAILED:<category>` for real failures so the error workflow
can classify transient vs permanent. It never receives customer, referral or credit data.

## Import / configure steps

1. Run the gateway on the same development host/network. The default gateway binds loopback; a container cannot use its own localhost to reach the host. Container networking is deliberately not configured in this phase.
2. Supply GATEWAY_BASE_URL to n8n as non-secret configuration. The HTTP Request expression uses $env; if environment access is blocked, configure that node's non-secret URL explicitly through the editor. Do not expose all secret environment variables to untrusted workflow authors.
3. Create a generic **Header Auth** credential in n8n: header name `x-gateway-key`; value from the gateway secret store. Select it in each `Run Private Gateway` node. No credential ID is invented in the JSON.
4. Import all three workflow JSON files via n8n's editor. In each workflow's Settings, select the imported error workflow by its actual instance-assigned ID. This binding must be verified manually before publishing; it cannot be pre-bound portably without a real instance ID.
5. Configure the schedules with `node scripts/configure-workflow.mjs` before import, or edit each Schedule Trigger directly.
6. Test a manual run with the console provider. Do not publish a schedule before verifying the first-run/backfill policy; current paid-order discovery scans all returned paid orders, including historical ones. Referral qualification is idempotent per window, so backfill behaviour is safe there.

The gateway owns retry and duplicate suppression. HTTP Request has retryOnFail=false. A partial-failure response throws a canonical error, which activates the Error Trigger during production-triggered n8n runs. Manual testing of error workflows differs in n8n; test the published development schedule after manual checks.

The error workflow classifies canonical failures and produces a sanitized intervention record. It does NOT yet send an external failure alert: no real provider is selected. Transport errors without a gateway response remain `GATEWAY_UNAVAILABLE_OR_UNKNOWN`; do not claim precise diagnosis without evidence. There is no automatic workflow replay. Failed executions must be monitored in n8n until an alert sink is approved.

No Alveron JWT, service email/password, payment secret or database credential belongs in n8n. Back up n8n's encryption key independently of workflow files. Never export decrypted credentials or commit pinData/execution payloads.

Official references reviewed: https://docs.n8n.io/flow-logic/error-handling/ and https://github.com/n8n-io/n8n (Schedule, HTTP Request, Code, Error Trigger). Node versions/import behavior must still be validated against the chosen installed stable release. No n8n install, import, publish or live execution has been performed here.
