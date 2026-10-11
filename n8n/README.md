# n8n setup — deployed but workflows remain inactive until final approval

Use official n8n, not a fork. Every workflow JSON here is inactive and contains no credentials.

## Workflows in this repository (all inactive)

| File | Purpose | Schedule |
|---|---|---|
| `workflows/paid-order-confirmation.json` | Workflow 1: paid-order customer confirmation + admin alert | `PAID_ORDER_POLL_MINUTES` (default 15 min) |
| `workflows/referral-qualification.json` | Phase 5: triggers Alveron's own `processPendingReferrals()` via `GET /referrals/admin/stats` | `REFERRAL_QUALIFICATION_POLL_MINUTES` (default 1 hour) |
| `workflows/product-request-notification.json` | New product-sourcing request admin alert (reads `GET /admin/product-requests`) | `PRODUCT_REQUEST_POLL_MINUTES` (default 15 min) |
| `workflows/low-stock-notification.json` | Low-stock, out-of-stock and **restock** admin alerts (reads `GET /products`; `variants[].stock` vs product `low_stock_alert`; restock = observed `previous <= 0 -> now > 0` via durable ledger state) | `LOW_STOCK_POLL_MINUTES` (default 6 hours) |
| `workflows/order-operations.json` | Operational order-status admin alerts **and customer lifecycle emails** (reads `GET /orders`; never PATCHes status) | `ORDER_OPERATIONS_POLL_MINUTES` (default 1 hour) |
| `workflows/payment-reconciliation.json` | Read-only payment anomaly scan (duplicate / unconfirmed / amount mismatch) | `PAYMENT_RECONCILIATION_POLL_MINUTES` (default 15 min) |
| `workflows/shipping-sla.json` | Paid orders past `SHIPPING_SLA_HOURS` without shipment | `SHIPPING_SLA_POLL_MINUTES` (default 1 hour) |
| `workflows/system-health.json` | Automation health snapshot (n8n, gateway, Alveron probe, Telegram configured) | `SYSTEM_HEALTH_POLL_MINUTES` (default 15 min) |
| `workflows/finance-daily-report.json` | Daily authoritative finance report (revenue, COGS, profit, expenses, payables, review/reconciliation) | `FINANCE_DAILY_REPORT_POLL_MINUTES` (default 1440 = daily) |
| `workflows/finance-weekly-report.json` | Weekly authoritative finance report with product contribution + expense categories | `FINANCE_WEEKLY_REPORT_POLL_MINUTES` (default 10080 = weekly) |
| `workflows/finance-reconciliation.json` | Read-only finance reconciliation review from Alveron's authoritative surface | `FINANCE_RECONCILIATION_POLL_MINUTES` (default 15 min) |
| `workflows/finance-expense-review.json` | Alerts on `pending_review` expenses; never approves | `FINANCE_EXPENSE_REVIEW_POLL_MINUTES` (default 30 min) |
| `workflows/finance-supplier-payables.json` | Due/overdue/partially-paid/large supplier payables | `FINANCE_SUPPLIER_PAYABLES_POLL_MINUTES` (default 1440 = daily) |
| `workflows/finance-review-digest.json` | One aggregated review message (incl. owner transactions) | `FINANCE_REVIEW_DIGEST_POLL_MINUTES` (default 1440 = daily) |
| `workflows/finance-anomaly-monitor.json` | Deterministic threshold anomalies over the authoritative daily report | `FINANCE_ANOMALY_MONITOR_POLL_MINUTES` (default 1440 = daily) |
| `workflows/finance-events-consumer.json` | Drains Alveron's `finance_events` outbox (typed read/ack): notifies on refunds, owner withdrawals/capital, unusual activity; ACK only after a successful notification | `FINANCE_EVENTS_CONSUMER_POLL_MINUTES` (default 15 min) |
| `workflows/automation-events.json` | Drains Alveron's `automation_events` outbox (typed read/ack): product-request status changes and order-issue alerts; ACK only after handling; unknown types left pending | `AUTOMATION_EVENTS_POLL_MINUTES` (default 15 min) |
| `workflows/daily-operations-summary.json` | One operational digest per business day to the owner/admin (orders, fulfilment, inventory, product requests, Alveron health). Finance figures are excluded | `DAILY_OPERATIONS_POLL_MINUTES` (default 1440 = daily) |
| `workflows/error-handler.json` | Shared Error Trigger: sanitized classification, best-effort Telegram admin alert, **no automatic replay** | n/a (bound per workflow in Settings) |

All schedules are configured by `node scripts/configure-workflow.mjs` (reads
`PAID_ORDER_POLL_MINUTES` / `REFERRAL_QUALIFICATION_POLL_MINUTES` / `PRODUCT_REQUEST_POLL_MINUTES` /
`LOW_STOCK_POLL_MINUTES` / `ORDER_OPERATIONS_POLL_MINUTES` / `PAYMENT_RECONCILIATION_POLL_MINUTES` /
`SHIPPING_SLA_POLL_MINUTES` / `SYSTEM_HEALTH_POLL_MINUTES`, the eight `FINANCE_*_POLL_MINUTES`
(including `FINANCE_EVENTS_CONSUMER_POLL_MINUTES`), and `AUTOMATION_EVENTS_POLL_MINUTES` /
`DAILY_OPERATIONS_POLL_MINUTES`;
clamps 5–1440, expresses minutes ≤59, whole hours ≤23, 1440 as one day or 10080 as one week, and always
leaves `active:false`).

## Automation outbox (Alveron-owned events)

Alveron exposes an `automation_events` outbox (mirroring `finance_events`) at
`GET /api/admin/automation/events` with `POST /api/admin/automation/events/:id/ack`, gated on the
`automation:view` / `automation:update` permissions. Alveron writes events as a best-effort side
effect of a business action; the automation consumer reads, validates, notifies and only then
acknowledges. Current event types: `product_request_created` (ack-only, already covered by the
product-request poller), `product_request_status_changed`, `order_issue_created`,
`order_issue_customer_contacted` / `order_issue_alternative_offered` (ack-only, internal admin
actions) and `order_issue_resolved`. An unknown event type is alerted once and left pending — never
guessed or silently dropped.

## Not implemented — blocked by the Alveron API

These phases cannot be built safely without an Alveron-side capability, so no placeholder workflow
is created:

| Capability | Missing in Alveron | Needed |
|---|---|---|
| Referral customer notifications | No per-referral event/recipient data (only aggregate stats) | `referral_events` outbox or per-referral records |
| Abandoned cart reminders | Cart reads are unauthenticated and expose no safe identity, `updated_at` or consent | Authenticated, consent-aware cart inactivity API |
| Customer restock interest ("notify me when 42 is back") | No product/variant interest table or signup API | Interest table + consent + unsubscribe |
| Marketing campaigns | No consent/audience/unsubscribe model exposed, no approval store | Consent + audience + unsubscribe API, campaign status |
| AI content + customer-service intelligence | No AI provider configured; no review/approval boundary | AI provider + human approval + publish gate |

Returns/exchange customer emails are **not** duplicated: Alveron's returns module already sends them
through Resend, so the automation only alerts the admin about operational status.

The finance workflows consume Alveron's authoritative finance contract (see
`docs/FINANCE_API_CONTRACT.md`). If Alveron returns 404/5xx for a finance endpoint, each run reports
`GATEWAY_RUN_FAILED|FINANCE_ENDPOINT_UNAVAILABLE|INVALID_RESPONSE|false` and the gateway sends one
CRITICAL `FINANCE_UNAVAILABLE` alert — no financial numbers are ever invented. Their result validator
accepts the uniform finance envelope returned by every finance route.

The outbox consumer additionally validates the extended envelope fields (`acked`, `unacked`,
`unhandled`). An event is never acknowledged before its notification succeeds, so a Telegram failure
leaves the event `pending` for the next run; unrecognised event types are alerted once and left
pending rather than guessed.

The referral workflow validates the sanitized gateway result, treats `duplicate` as a legitimate no-op
(HTTP 200), and throws a structured `REFERRAL_QUALIFICATION_FAILED|code|category|transient` marker for real
failures so the error workflow classifies them without raw upstream text. It never receives customer,
referral, or credit data.

## Import / configure steps

1. Production: n8n runs in Docker with `network_mode: host` (see `deploy/docker-compose.yml`) so its loopback is the host loopback and it can reach the private gateway at `127.0.0.1:8787`. The n8n container binds `N8N_LISTEN_ADDRESS=127.0.0.1`; nginx (on the host) terminates TLS. The gateway base URL is pinned in each workflow's HTTP Request node (`http://127.0.0.1:8787`) because it is non-secret host-local configuration.
2. `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` on the instance: workflows never read process environment, so container secrets (DB credentials, encryption key) are not reachable from expressions or Code nodes. The pinned gateway URL is deliberately static rather than `$env`-driven for this reason.
3. Create a generic **Header Auth** credential in n8n: header name `x-gateway-key`; value from the gateway secret store. Select it in every `Run Private Gateway` node and in `Request Telegram Admin Alert`. No credential ID or Telegram secret is invented in the JSON.
4. Import the workflow JSON files with `npm run n8n:import` (or `n8n import:workflow --separate --activeState=false --input=n8n/workflows`). Every file pins a stable `id` and each non-error workflow's `settings.errorWorkflow` points at the error workflow's stable id, so a fresh import reproduces the error-workflow relationship without matching instance ids by hand. `npm run validate:workflows` asserts the bindings (inactive, unique stable ids, error binding) and `npm run n8n:import` refuses to import if any check fails. Default CLI import (`--activeState=false`) always arrives inactive.
5. Configure the schedules with `node scripts/configure-workflow.mjs` before import (reads the four `*_POLL_MINUTES` values, clamps 5–1440, and always leaves `active:false`), or edit each Schedule Trigger directly.
6. Test a manual run with the console provider (`EMAIL_PROVIDER=console`, `ALVERON_AUTOMATION_MODE=test`). Do not publish a schedule before verifying the first-run/backfill policy; paid-order discovery is bounded by `ALVERON_ORDER_MAX_PAGES` and deduplicated by order id, and the ledger suppresses anything already notified. Referral qualification is idempotent per window, so backfill behaviour is safe there.

## Activation (operator-only, never automatic)

Import, `docker compose up`, restarts and re-imports all leave workflows **inactive**:
`configure-workflow.mjs` forces `active:false`, and `import:workflow` defaults to
`--activeState=false`. Nothing in this repository activates a workflow or trigger; there is no
startup/import hook that publishes.

The only activation mechanism is an explicit, per-workflow operator command. Publish one workflow
at a time, only after the runbook activation gate is signed off:

```bash
docker exec alveron-n8n n8n list:workflow                       # confirm ids + that none are active
docker exec alveron-n8n n8n publish:workflow --id=<workflow-id> # activate ONE approved workflow
docker exec alveron-n8n n8n unpublish:workflow --id=<workflow-id> # deactivate it again
```

The shared error workflow (`Alveron Automation — Error Classification (DEV)`, id
`T0o2hhdklxob9bkX`) stays **inactive** — n8n runs an error workflow when a workflow fails even
while it is unpublished, so it does not need activating. Never bulk-publish.

The gateway owns retry and duplicate suppression. HTTP Request has retryOnFail=false. A partial-failure response throws a canonical error, which activates the Error Trigger during production-triggered n8n runs. Manual testing of error workflows differs in n8n; test the published development schedule after manual checks.

The error workflow classifies canonical failures and sends only an allowlisted payload to the private gateway. The gateway owns the Telegram token and selected admin chat; workflow JSON never contains either value. The HTTP node uses `neverError` and `continueRegularOutput` so a missing credential, rejected request, provider outage, or Telegram failure cannot recurse through the Error Trigger. Its final Code node logs only a sanitized delivery result when the gateway or Telegram did not accept the alert. There is no automatic workflow replay.

Gateway/Telegram failures are isolated from paid-order, referral, product-request, low-stock, and customer-email outcomes. The gateway response contains an `adminNotifications` summary, and its journal records metadata-only notification events. `PENDING` means delivery is ambiguous and is deliberately not resent automatically because Telegram has no idempotency key; inspect the ledger row and make an explicit operator decision rather than deleting it blindly.

No Telegram bot token/admin chat ID, Alveron JWT, service email/password, payment secret or database credential belongs in n8n. Back up n8n's encryption key independently of workflow files. Never export decrypted credentials or commit pinData/execution payloads.

Official references reviewed: https://docs.n8n.io/flow-logic/error-handling/ and https://github.com/n8n-io/n8n (Schedule, HTTP Request, Code, Error Trigger). Deployment here is pinned to `n8nio/n8n:2.39.8` (see `deploy/docker-compose.yml`); schedules stay inactive until final approval. No workflow has been activated or executed.
