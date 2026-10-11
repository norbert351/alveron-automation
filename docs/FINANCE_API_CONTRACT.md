# Alveron Finance API contract (read-only) — consumed by n8n finance automation

**Status: SERVED BY ALVERON** (`apps/api/src/modules/finance/finance-bridge.service.ts`, mounted
under `/api/admin/finance/*`). The finance automation layer is built fail-closed against this
contract: if an endpoint ever returns HTTP 404 (not deployed / wrong environment), the client retags
it as `FINANCE_ENDPOINT_UNAVAILABLE`, sends one CRITICAL `FINANCE_UNAVAILABLE` admin alert and reports
the run as failed. No financial number is ever invented, defaulted to zero, or recomputed in n8n.

## Architecture rule

Alveron is the financial source of truth. n8n:

- consumes authoritative values verbatim;
- may compute only explicitly-labelled **presentation** metrics (period-over-period change, ratios);
- must never derive an authoritative revenue, COGS, profit, cash or payable figure;
- must never write finance data.

Every endpoint below is `GET`, admin-scoped (`Roles('admin')` / a finance permission), read-only, and
served from the Alveron API under `/api`. All money is **whole naira (NGN)**, may be negative where a
loss is meaningful, and is never kobo. Missing fields are `null`; the automation renders them as
"not provided" and never substitutes zero.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/finance/overview` | Current authoritative overview — **native shape**, see note below |
| `GET` | `/api/admin/finance/reports/daily` | End-of-day report (current + previous) |
| `GET` | `/api/admin/finance/reports/weekly` | Weekly report incl. product contribution + expense categories |
| `GET` | `/api/admin/finance/reconciliation` | Authoritative reconciliation issues |
| `GET` | `/api/admin/finance/expenses/pending-review` | Expenses awaiting review |
| `GET` | `/api/admin/finance/supplier-payables` | Outstanding supplier payables |
| `GET` | `/api/admin/finance/review-queue` | Aggregated review items |
| `GET` | `/api/admin/finance/withdrawals` | Owner withdrawals/contributions |

The client’s outbound HTTP allowlist accepts exactly these static, query-free paths (see
`src/integrations/alveron/finance.ts`). No caller-supplied URL, query string, host or key can reach
the network.

**`/overview` shape note (verified against the deployed API).** `/admin/finance/overview` is shared
with the Alveron admin UI and is served in Alveron's **native** shape — `{ period, summary, cash,
safeWithdrawal, ownerCapital, payablesOutstandingMinor, reviewRequired }` in **minor units** — not
the whole-naira bridge shape used by the seven report/list endpoints. The automation parses it
strictly as served (`parseFinanceNativeOverview`) without converting or deriving any value. No
finance workflow depends on `/overview`; daily/weekly reports already carry cash, capital, working
capital and metrics. If Alveron later dedicates a bridge-shaped overview path, point
`FINANCE_ENDPOINTS.overview` at it and switch the client back to `parseFinanceOverview`.

## Shared metric shape

`orders, revenue, cogs, grossProfit, operatingExpenses, paymentFees, refunds, netProfit,
supplierPayables, reviewItems, reconciliationIssues, missingCostItems` — each integer or `null`.
`netProfit`/`grossProfit` are provided by Alveron, **not** computed by n8n. `refunds` and
`paymentFees` are values Alveron already knows; n8n does not derive them.

## Cash, capital and working capital (top level of overview + reports)

Cash and owner capital are **positions**, not period figures, so they sit at the
top level of `/overview`, `/reports/daily` and `/reports/weekly` (never inside
`current`/`previous`). Owner capital movement is cumulative (opening capital +
all contributions − all withdrawals); it is owner equity and is never revenue,
COGS, profit or an expense:

```jsonc
{
  "estimatedCash": 512000,                      // integer whole naira
  "capital": {
    "status": "not_entered",                     // not_entered | entered | updated
    "openingCapital": 0,                         // 0 only when status != not_entered
    "contributions": 0,
    "withdrawals": 0,
    "netMovement": 0
  },
  "workingCapital": {
    "estimatedCash": 512000,
    "supplierPayablesOutstanding": 74000,
    "upcomingSupplierPayments": 60000,
    "overdueSupplierPayments": 14000,
    "pendingRefunds": 8000,
    "otherKnownCommitments": 45000,
    "reserves": 10000,
    "estimatedSafeToWithdraw": 375000,
    "isEstimate": true
  }
}
```

**Capital status rule.** `capital.status === "not_entered"` means the owner has
not recorded opening capital yet. The UI and Telegram render this as
`Capital: Not entered` and **must not** show a fabricated `₦0`. Only when the
owner explicitly records an actual zero does `status` become `entered`.

**Working capital is an estimate.** Every `workingCapital` value is labelled
`isEstimate: true`; it is a management view of cash minus commitments, never a
guaranteed bank balance.

## Response shapes

```jsonc
// /reports/daily
{
  "asOf": "2026-10-04T09:00:00.000Z",
  "currency": "NGN",
  "period": { "start": "2026-10-03T00:00:00.000Z", "end": "2026-10-03T23:59:59.000Z" },
  "current": { "revenue": 385000, "cogs": 226000, "grossProfit": 159000,
               "operatingExpenses": 31000, "netProfit": 128000, "refunds": 8000,
               "paymentFees": 4000, "supplierPayables": 74000,
               "reviewItems": 1, "reconciliationIssues": 0, "missingCostItems": 0, "orders": 12 },
  "previous": { ...same shape or null... },
  "estimatedCash": 512000,
  "capital": { ... },
  "workingCapital": { ... }
}
```

```jsonc
// /reports/weekly  (current/previous + these two arrays)
{
  "asOf": "...", "currency": "NGN", "period": {...},
  "current": {...}, "previous": {...},
  "productProfitability": [ { "title": "Premium Polo", "contributionProfit": 300000, "units": 40 } ],
  "largestExpenseCategories": [ { "category": "Marketing", "amount": 90000 } ],
  "estimatedCash": 512000,
  "capital": { ... },
  "workingCapital": { ... }
}
```

```jsonc
// /reconciliation
{ "asOf": "...", "issueCount": 1,
  "issues": [ { "id": "issue-1", "orderNumber": 1042, "code": "AMOUNT_MISMATCH",
                "expected": 68000, "actual": 66000, "reference": "PAY-XXXX1234", "detail": "..." } ] }

// /expenses/pending-review
{ "total": 1, "items": [ { "id": "exp-1", "amount": 25000, "category": null,
                           "description": "Supplier transport", "status": "pending_review",
                           "incurredAt": "2026-10-04T08:00:00.000Z" } ] }

// /supplier-payables
{ "total": 1, "totalOutstanding": 120000, "items": [
  { "id": "pay-1", "supplier": "ABC Supplier", "outstanding": 120000,
    "dueDate": "2026-10-06T00:00:00.000Z", "status": "due_soon", "reference": "..." } ] }

// /review-queue
{ "asOf": "...", "total": 3, "items": [
  { "id": "r1", "kind": "PAYMENT", "title": "Payment mismatch — Order #1042",
    "amount": 68000, "reference": "...", "action": "Review in Admin → Finance → Reconciliation" } ] }

// /withdrawals
{ "total": 1, "items": [ { "id": "w1", "type": "WITHDRAWAL", "amount": 100000,
                           "recordedAt": "2026-10-04T09:00:00.000Z", "reference": "..." } ] }
```

**Enums**

- reconciliation `code`: `UPPER_SNAKE` (e.g. `PAID_NOT_RECONCILED`, `PAYMENT_WITHOUT_ORDER`,
  `AMOUNT_MISMATCH`, `DUPLICATE_REFERENCE`, `REFUND_MISMATCH`).
- review `kind`: `PAYMENT | RECONCILIATION | EXPENSE | SUPPLIER | MISSING_COST | REFUND | WITHDRAWAL | OTHER`.
- payable `status` (lowercase): `due_soon`, `due`, `overdue`, `partially_paid`, `settled`, `paid`, …
- withdrawal `type`: `WITHDRAWAL | CONTRIBUTION`.

## Finance events outbox (n8n consumer)

Alveron serves its `finance_events` outbox through the SAME authenticated, admin-scoped API. This is
the **only** non-financial write the automation is permitted (`ack`), and it only flips an outbox row
from `pending` to `delivered`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/finance/events?status=pending&page=1&pageSize=50` | Read pending events (bounded pagination only) |
| `POST` | `/api/admin/finance/events/:id/ack` | Mark one event delivered (no body) |

```jsonc
// GET /events  -> { items, total, page, pageSize, pages }
{ "items": [ { "id": "9f1c…", "event_type": "owner_transaction_recorded",
               "payload": { "type": "owner_draw", "amountMinor": 15000000 },
               "status": "pending", "idempotency_key": "owner_tx:2b7e…",
               "created_at": "2026-10-04T09:00:00.000Z", "delivered_at": null,
               "review_status": null } ],
  "total": 1, "page": 1, "pageSize": 50, "pages": 1 }
```

**Served event types** (`apps/api/src/modules/finance/finance-events.ts`): `payment_confirmed`,
`sale_recorded`, `refund_recorded`, `expense_created`, `expense_requires_review`, `expense_approved`,
`reconciliation_failed`, `supplier_payment_due`, `supplier_payment_recorded`,
`owner_transaction_recorded`, `unusual_financial_activity`.

**Payload amounts are minor units (kobo)**, unlike the whole-naira bridge endpoints. The consumer
renders them exactly (no rounding); e.g. `15000000` → `₦150,000`.

**Consumer semantics** (`finance-events-consumer`, inactive by default):

- `FETCH → VALIDATE → PROCESS → NOTIFY → RECORD SUCCESS → ACK`. An event is **never** acknowledged
  before its notification succeeded; a Telegram failure, a disabled provider or an ambiguous send
  leaves the event `pending` for a later retry.
- Idempotent per authoritative event identity. Notification keys reuse the same ledger keys as the
  polling workflows where one exists (`owner-withdrawal:<id>`, `finance-expense-review:<id>`,
  `finance-reconciliation:…`), so a polling workflow and the outbox can never double-notify the same
  business event.
- `payment_confirmed`, `sale_recorded`, `expense_created`, `expense_approved`, `supplier_payment_due`
  and `supplier_payment_recorded` are acknowledged **without** a Telegram message: an existing
  polling workflow already owns the equivalent business alert. This drains the outbox without
  duplicating notifications.
- An unrecognised event type is alerted once (`FINANCE_UNAVAILABLE` with reason
  `UNKNOWN_EVENT_TYPE:<type>`) and **left pending** — fail-closed, never guessed. No event is ever
  dropped or invented.

## Finance configuration (timezone, thresholds, schedules)

**`FINANCE_TIMEZONE`** (gateway runtime) controls how periods and business days are displayed. It is
display-only — values remain Alveron-authoritative. Production value: **`Africa/Lagos`** (explicit in
`deploy/gateway.env`; the code default is the same, so no value was silently changed).

**Anomaly thresholds** (gateway runtime; deterministic monitoring gates over authoritative values,
never calculations). `0` means the signal is **disabled** — it is never interpreted as "trigger
immediately" and no threshold is invented.

| Variable | Current | Meaning | State | Operator decision |
|---|---|---|---|---|
| `FINANCE_EXPENSE_SPIKE_THRESHOLD` | `0` | Daily operating expenses above this whole-naira value | Disabled | Enable with a business-agreed ₦ ceiling when ready |
| `FINANCE_REFUND_RATE_THRESHOLD_PERCENT` | `0` | Refunds as % of revenue above this value | Disabled | Enable with a business-agreed % when ready |
| `FINANCE_REVENUE_DROP_THRESHOLD_PERCENT` | `0` | Revenue drop vs previous period, percent | Disabled | Enable with a business-agreed % when ready |
| `FINANCE_RECONCILIATION_ISSUE_THRESHOLD` | `0` | Reconciliation issues above this count | Disabled | Enable with a business-agreed count when ready |
| `FINANCE_PAYABLE_SPIKE_THRESHOLD` | `0` | Supplier payables above this whole-naira value | Disabled | Enable with a business-agreed ₦ ceiling when ready |
| `FINANCE_MISSING_COST_THRESHOLD` | `0` | Missing product-cost items above this count | Disabled | Enable with a business-agreed count when ready |
| `FINANCE_LARGE_PAYABLE_THRESHOLD` | `0` | Supplier payable at/above this whole-naira value is "large" | Disabled | Enable with a business-agreed ₦ value when ready |

**Schedule configuration** (`FINANCE_*_POLL_MINUTES`, import-time, consumed by
`scripts/configure-workflow.mjs`; the script always leaves `active:false`):

| Workflow | Env var | Minutes |
|---|---|---|
| finance-daily-report | `FINANCE_DAILY_REPORT_POLL_MINUTES` | 1440 |
| finance-weekly-report | `FINANCE_WEEKLY_REPORT_POLL_MINUTES` | 10080 |
| finance-reconciliation | `FINANCE_RECONCILIATION_POLL_MINUTES` | 15 |
| finance-expense-review | `FINANCE_EXPENSE_REVIEW_POLL_MINUTES` | 30 |
| finance-supplier-payables | `FINANCE_SUPPLIER_PAYABLES_POLL_MINUTES` | 1440 |
| finance-review-digest | `FINANCE_REVIEW_DIGEST_POLL_MINUTES` | 1440 |
| finance-anomaly-monitor | `FINANCE_ANOMALY_MONITOR_POLL_MINUTES` | 1440 |
| finance-events-consumer | `FINANCE_EVENTS_CONSUMER_POLL_MINUTES` | 15 |

## Validation / failure behaviour

- A malformed response fails the whole call (`INVALID_RESPONSE`); a partial finance report is worse
  than none.
- HTTP 404 ⇒ `FINANCE_ENDPOINT_UNAVAILABLE` ⇒ CRITICAL unavailable alert, run `failed`. A 404/5xx
  **never** causes n8n to fabricate revenue, profit, cash, expenses or payables; the only output is
  the configured `FINANCE_ENDPOINT_UNAVAILABLE` critical alert, deduplicated by the existing
  idempotency ledger so repeat failures do not spam Telegram.
- 401/403/429/5xx/timeouts reuse the existing transport classification (`AUTHENTICATION_ERROR`,
  `AUTHORIZATION_ERROR`, `RATE_LIMITED`, `ALVERON_SERVER_ERROR`, `NETWORK_ERROR`).
- Sensitive payment references are masked (last 4 chars) before display; customer PII never appears.

## Security

No Supabase service-role key and no Paystack secret key are used by n8n. Finance data is fetched by
the private gateway using the existing Alveron service-account session; n8n only ever POSTs to
loopback gateway routes. See the top-level `README.md` and `deploy/OPERATOR_RUNBOOK.md`.
