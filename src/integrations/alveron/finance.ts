import { AppError } from './errors.js';

/**
 * Finance API contract (read-only) for the Alveron private gateway.
 *
 * ARCHITECTURE RULE: Alveron is the financial source of truth. Every value parsed here is taken
 * verbatim from Alveron; this module never derives an authoritative revenue, COGS, profit or cash
 * figure. A field Alveron does not provide is represented as `null` (rendered as "not provided")
 * and is NEVER defaulted to zero or recomputed from other fields.
 *
 * The contract is defined ahead of Alveron's implementation so the automation layer is complete
 * and fail-closed: until Alveron serves these endpoints, the finance client raises
 * `FINANCE_ENDPOINT_UNAVAILABLE` and the workflows alert rather than fabricate.
 *
 * A successfully-parsed envelope is required. Unlike the catalogue reader (which may skip
 * individual malformed rows), finance parsing is strict: a single malformed required field fails
 * the whole response, because a partial financial report would be worse than no report.
 */

/**
 * Exact Alveron finance paths this automation is permitted to read. Static, query-free paths keep
 * the outbound allowlist tight; the gateway derives any period server-side.
 */
export const FINANCE_ENDPOINTS = {
  overview: '/admin/finance/overview',
  dailyReport: '/admin/finance/reports/daily',
  weeklyReport: '/admin/finance/reports/weekly',
  reconciliation: '/admin/finance/reconciliation',
  pendingReviewExpenses: '/admin/finance/expenses/pending-review',
  supplierPayables: '/admin/finance/supplier-payables',
  reviewQueue: '/admin/finance/review-queue',
  withdrawals: '/admin/finance/withdrawals',
} as const;

export const FINANCE_READ_PATHS: readonly string[] = Object.values(FINANCE_ENDPOINTS);

/**
 * Finance outbox (n8n automation events), served by Alveron at `/api/admin/finance/events`.
 *
 * Alveron writes business events into its `finance_events` table; this automation polls the
 * authenticated endpoint, processes each event idempotently and then acknowledges it. n8n never
 * touches the database directly and never receives a service-role credential. The event list is
 * static except for the pagination query, and acknowledgement is the ONE typed, non-financial POST
 * the transport permits (it only flips an outbox row from `pending` to `delivered`).
 */
export const FINANCE_EVENTS_PATH = '/admin/finance/events';

export const FINANCE_ACTIVE_EVENT_TYPES = [
  'payment_confirmed',
  'sale_recorded',
  'refund_recorded',
  'expense_created',
  'expense_requires_review',
  'expense_approved',
  'reconciliation_failed',
  'supplier_payment_due',
  'supplier_payment_recorded',
  'owner_transaction_recorded',
  'unusual_financial_activity',
] as const;

export type FinanceEventType = (typeof FINANCE_ACTIVE_EVENT_TYPES)[number];

const activeEventTypes = new Set<string>(FINANCE_ACTIVE_EVENT_TYPES);

export interface FinanceEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered';
  idempotencyKey: string | null;
  createdAt: string;
  deliveredAt: string | null;
  reviewStatus: string | null;
}

export interface FinanceEventPage {
  items: FinanceEvent[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export const isKnownFinanceEventType = (eventType: string): eventType is FinanceEventType =>
  activeEventTypes.has(eventType);

const optionalToken = (value: unknown, max: number, pattern: RegExp): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) return badResponse();
  return value;
};

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return badResponse();
  return value;
};

function parseFinanceEvent(value: unknown): FinanceEvent {
  const event = record(value);
  const status = requiredText(event['status'], 20);
  if (status !== 'pending' && status !== 'delivered') return badResponse();
  const payload = event['payload'] === null || event['payload'] === undefined ? {} : record(event['payload']);
  return {
    id: uuid(event['id']),
    eventType: requiredText(event['event_type'], 64),
    payload,
    status,
    idempotencyKey: optionalToken(event['idempotency_key'], 240, /^[A-Za-z0-9:_.-]{1,240}$/),
    createdAt: requiredIso(event['created_at']),
    deliveredAt: optionalIso(event['delivered_at']),
    reviewStatus: optionalToken(event['review_status'], 40, /^[a-z_]{1,40}$/),
  };
}

/** Strict outbox page. A malformed page fails whole; the workflow never fabricates an event. */
export function parseFinanceEventPage(value: unknown): FinanceEventPage {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parseFinanceEvent);
  const page = count(body['page']);
  const pageSize = count(body['pageSize']);
  const pages = count(body['pages']);
  if (page === null || pageSize === null || pageSize < 1 || pages === null) return badResponse();
  return { items, total: count(body['total']) ?? items.length, page, pageSize, pages };
}

/** Acknowledgement receipt. Confirms Alveron actually flipped the row to `delivered`. */
export function parseFinanceEventAck(value: unknown): { id: string; status: 'delivered' } {
  const body = record(value);
  const status = requiredText(body['status'], 20);
  if (status !== 'delivered') return badResponse();
  return { id: uuid(body['id']), status };
}

// Payload field helpers for the typed event handlers. Absent is null, never zero.
export const eventMoney = (payload: Record<string, unknown>, key: string): number | null =>
  money(payload[key]);
export const eventCount = (payload: Record<string, unknown>, key: string): number | null =>
  count(payload[key]);

/** Extract an owner ledger row id from an authoritative idempotency key such as `owner_tx:<id>`. */
export function ownerLedgerIdFromIdempotencyKey(key: string | null): string | null {
  if (!key) return null;
  const match = /^(?:owner_tx|opening_capital):([0-9a-fA-F-]{36})$/.exec(key);
  return match ? match[1]!.toLowerCase() : null;
}

/** Extract an order id from an authoritative idempotency key such as `sale_recorded:order:<id>`. */
export function orderIdFromIdempotencyKey(key: string | null): string | null {
  if (!key) return null;
  const match = /^(?:payment_confirmed|sale_recorded|refund_recorded):order:([0-9a-fA-F-]{36})$/.exec(key);
  return match ? match[1]!.toLowerCase() : null;
}

const badResponse = (): never => { throw new AppError('INVALID_RESPONSE'); };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : badResponse();

/** Whole-naira money value. May be negative (e.g. net loss). Absent => null, never 0. */
const money = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return badResponse();
  return value;
};

/** Non-negative whole count. Absent => null, never 0. */
const count = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return badResponse();
  return value;
};

const requiredText = (value: unknown, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) return badResponse();
  return value.trim();
};

const optionalText = (value: unknown, max = 300): string | null =>
  value === null || value === undefined ? null : requiredText(value, max);

const optionalIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40) return badResponse();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const requiredIso = (value: unknown): string => {
  const iso = optionalIso(value);
  if (!iso) return badResponse();
  return iso;
};

const identifier = (value: unknown): string =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) &&
  /^[A-Za-z0-9:_-]{1,240}$/.test(String(value)) ? String(value) : badResponse();

const code = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return badResponse();
  return value;
};

export interface FinancePeriod {
  start: string | null;
  end: string | null;
}

export const parseFinancePeriod = (value: unknown): FinancePeriod => {
  if (value === null || value === undefined) return { start: null, end: null };
  const period = record(value);
  return { start: optionalIso(period['start']), end: optionalIso(period['end']) };
};

/** The authoritative daily/weekly figures. Every field is nullable; none is ever derived here. */
export interface FinanceMetrics {
  orders: number | null;
  revenue: number | null;
  cogs: number | null;
  grossProfit: number | null;
  operatingExpenses: number | null;
  paymentFees: number | null;
  refunds: number | null;
  netProfit: number | null;
  supplierPayables: number | null;
  reviewItems: number | null;
  reconciliationIssues: number | null;
  missingCostItems: number | null;
}

export const parseFinanceMetrics = (value: unknown): FinanceMetrics => {
  const m = record(value);
  return {
    orders: count(m['orders']),
    revenue: money(m['revenue']),
    cogs: money(m['cogs']),
    grossProfit: money(m['grossProfit']),
    operatingExpenses: money(m['operatingExpenses']),
    paymentFees: money(m['paymentFees']),
    refunds: money(m['refunds']),
    netProfit: money(m['netProfit']),
    supplierPayables: money(m['supplierPayables']),
    reviewItems: count(m['reviewItems']),
    reconciliationIssues: count(m['reconciliationIssues']),
    missingCostItems: count(m['missingCostItems']),
  };
};

export type FinanceCapitalStatus = 'not_entered' | 'entered' | 'updated';

/**
 * Owner capital. `status === 'not_entered'` is a first-class state meaning opening capital has not
 * been recorded yet — it must render as "Not entered", never as a fabricated ₦0. Capital is owner
 * equity: it never enters revenue, COGS, profit or expenses.
 */
export interface FinanceCapital {
  status: FinanceCapitalStatus;
  openingCapital: number | null;
  contributions: number | null;
  withdrawals: number | null;
  netMovement: number | null;
}

export const parseFinanceCapital = (value: unknown): FinanceCapital | null => {
  if (value === null || value === undefined) return null;
  const capital = record(value);
  const status = requiredText(capital['status'], 20);
  if (status !== 'not_entered' && status !== 'entered' && status !== 'updated') return badResponse();
  return {
    status,
    openingCapital: money(capital['openingCapital']),
    contributions: money(capital['contributions']),
    withdrawals: money(capital['withdrawals']),
    netMovement: money(capital['netMovement']),
  };
};

/** Working-capital / commitments snapshot. Always an estimate; never a guaranteed bank balance. */
export interface FinanceWorkingCapital {
  estimatedCash: number | null;
  supplierPayablesOutstanding: number | null;
  upcomingSupplierPayments: number | null;
  overdueSupplierPayments: number | null;
  pendingRefunds: number | null;
  otherKnownCommitments: number | null;
  reserves: number | null;
  estimatedSafeToWithdraw: number | null;
  isEstimate: boolean;
}

export const parseFinanceWorkingCapital = (value: unknown): FinanceWorkingCapital | null => {
  if (value === null || value === undefined) return null;
  const wc = record(value);
  return {
    estimatedCash: money(wc['estimatedCash']),
    supplierPayablesOutstanding: money(wc['supplierPayablesOutstanding']),
    upcomingSupplierPayments: money(wc['upcomingSupplierPayments']),
    overdueSupplierPayments: money(wc['overdueSupplierPayments']),
    pendingRefunds: money(wc['pendingRefunds']),
    otherKnownCommitments: money(wc['otherKnownCommitments']),
    reserves: money(wc['reserves']),
    estimatedSafeToWithdraw: money(wc['estimatedSafeToWithdraw']),
    isEstimate: wc['isEstimate'] === true,
  };
};

interface FinanceContext {
  estimatedCash: number | null;
  capital: FinanceCapital | null;
  workingCapital: FinanceWorkingCapital | null;
}

function parseFinanceContext(body: Record<string, unknown>): FinanceContext {
  return {
    estimatedCash: money(body['estimatedCash']),
    capital: parseFinanceCapital(body['capital']),
    workingCapital: parseFinanceWorkingCapital(body['workingCapital']),
  };
}

export interface FinanceOverview extends FinanceMetrics, FinanceContext {
  asOf: string;
  currency: string;
  period: FinancePeriod;
}

export function parseFinanceOverview(value: unknown): FinanceOverview {
  const body = record(value);
  const currency = requiredText(body['currency'], 8);
  if (currency !== 'NGN') return badResponse();
  return {
    asOf: requiredIso(body['asOf']), currency, period: parseFinancePeriod(body['period']),
    ...parseFinanceMetrics(body), ...parseFinanceContext(body),
  };
}

/**
 * The `/admin/finance/overview` route is shared with the Alveron admin UI and is served in Alveron's
 * **native** shape (minor units; `summary`/`cash`/`safeWithdrawal`/`ownerCapital`), NOT the
 * whole-naira bridge shape used by the other finance contract endpoints. This parser reads that
 * served shape verbatim and NEVER converts or derives a value, so it cannot fabricate a figure.
 *
 * NOTE: no finance workflow depends on `/overview` — daily/weekly reports already carry cash,
 * capital, working capital and metrics. This method exists for contract completeness.
 */
export interface FinanceNativeOverview {
  period: { key: string | null; label: string | null; from: string | null; to: string | null };
  summary: Record<string, number | string | boolean | null>;
  cash: Record<string, number | string | boolean | null>;
  safeWithdrawal: Record<string, number | string | boolean | null>;
  ownerCapital: Record<string, number | string | boolean | null>;
  payablesOutstandingMinor: number | null;
  reviewRequired: number | null;
}

function parseMinorRecord(value: unknown): Record<string, number | string | boolean | null> {
  const body = record(value);
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (raw === null || raw === undefined) { out[key] = null; continue; }
    if (typeof raw === 'boolean') { out[key] = raw; continue; }
    if (typeof raw === 'string') { out[key] = requiredText(raw, 500); continue; }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return badResponse();
    out[key] = raw;
  }
  return out;
}

export function parseFinanceNativeOverview(value: unknown): FinanceNativeOverview {
  const body = record(value);
  const period = record(body['period']);
  const summary = parseMinorRecord(body['summary']);
  const cash = parseMinorRecord(body['cash']);
  const safeWithdrawal = parseMinorRecord(body['safeWithdrawal']);
  const ownerCapital = record(body['ownerCapital']);
  return {
    period: {
      key: optionalText(period['key'], 40),
      label: optionalText(period['label'], 80),
      from: optionalIso(period['from']),
      to: optionalIso(period['to']),
    },
    summary,
    cash,
    safeWithdrawal,
    ownerCapital: (() => {
      const out: Record<string, number | string | boolean | null> = {};
      for (const [key, raw] of Object.entries(ownerCapital)) {
        if (raw === null || raw === undefined) { out[key] = null; continue; }
        if (typeof raw === 'boolean') { out[key] = raw; continue; }
        if (typeof raw === 'string') { out[key] = requiredText(raw, 500); continue; }
        out[key] = money(raw);
      }
      return out;
    })(),
    payablesOutstandingMinor: money(body['payablesOutstandingMinor']),
    reviewRequired: count(body['reviewRequired']),
  };
}

export interface FinanceDailyReport extends FinanceContext {
  asOf: string;
  currency: string;
  period: FinancePeriod;
  current: FinanceMetrics;
  previous: FinanceMetrics | null;
}

export function parseFinanceDailyReport(value: unknown): FinanceDailyReport {
  const body = record(value);
  const currency = requiredText(body['currency'], 8);
  if (currency !== 'NGN') return badResponse();
  const previous = body['previous'] === null || body['previous'] === undefined
    ? null : parseFinanceMetrics(body['previous']);
  return {
    asOf: requiredIso(body['asOf']), currency, period: parseFinancePeriod(body['period']),
    current: parseFinanceMetrics(body['current']), previous,
    ...parseFinanceContext(body),
  };
}

export interface FinanceProductProfit {
  title: string;
  contributionProfit: number | null;
  units: number | null;
}

export interface FinanceExpenseCategory {
  category: string;
  amount: number | null;
}

export interface FinanceWeeklyReport extends FinanceContext {
  asOf: string;
  currency: string;
  period: FinancePeriod;
  current: FinanceMetrics;
  previous: FinanceMetrics | null;
  productProfitability: FinanceProductProfit[];
  largestExpenseCategories: FinanceExpenseCategory[];
}

function parseProductProfit(value: unknown): FinanceProductProfit {
  const item = record(value);
  return { title: requiredText(item['title'], 200), contributionProfit: money(item['contributionProfit']), units: count(item['units']) };
}

function parseExpenseCategory(value: unknown): FinanceExpenseCategory {
  const item = record(value);
  return { category: requiredText(item['category'], 120), amount: money(item['amount']) };
}

export function parseFinanceWeeklyReport(value: unknown): FinanceWeeklyReport {
  const body = record(value);
  const currency = requiredText(body['currency'], 8);
  if (currency !== 'NGN') return badResponse();
  if (!Array.isArray(body['productProfitability']) || !Array.isArray(body['largestExpenseCategories'])) return badResponse();
  const previous = body['previous'] === null || body['previous'] === undefined
    ? null : parseFinanceMetrics(body['previous']);
  return {
    asOf: requiredIso(body['asOf']), currency, period: parseFinancePeriod(body['period']),
    current: parseFinanceMetrics(body['current']), previous,
    productProfitability: body['productProfitability'].map(parseProductProfit),
    largestExpenseCategories: body['largestExpenseCategories'].map(parseExpenseCategory),
    ...parseFinanceContext(body),
  };
}

export interface FinanceReconciliationIssue {
  id: string;
  orderNumber: number | null;
  code: string;
  expected: number | null;
  actual: number | null;
  reference: string | null;
  detail: string | null;
}

export interface FinanceReconciliation {
  asOf: string;
  issues: FinanceReconciliationIssue[];
  issueCount: number;
}

function parseReconciliationIssue(value: unknown): FinanceReconciliationIssue {
  const issue = record(value);
  return {
    id: identifier(issue['id']),
    orderNumber: count(issue['orderNumber']),
    code: code(issue['code']),
    expected: money(issue['expected']),
    actual: money(issue['actual']),
    reference: optionalText(issue['reference'], 120),
    detail: optionalText(issue['detail'], 400),
  };
}

export function parseFinanceReconciliation(value: unknown): FinanceReconciliation {
  const body = record(value);
  if (!Array.isArray(body['issues'])) return badResponse();
  const issues = body['issues'].map(parseReconciliationIssue);
  return { asOf: requiredIso(body['asOf']), issues, issueCount: count(body['issueCount']) ?? issues.length };
}

export interface FinanceReviewItem {
  id: string;
  kind: string;
  title: string;
  amount: number | null;
  reference: string | null;
  action: string | null;
}

export interface FinanceReviewQueue {
  asOf: string;
  items: FinanceReviewItem[];
  total: number;
}

const reviewKinds = new Set([
  'PAYMENT', 'RECONCILIATION', 'EXPENSE', 'SUPPLIER', 'MISSING_COST', 'REFUND', 'WITHDRAWAL', 'OTHER',
]);

function parseReviewItem(value: unknown): FinanceReviewItem {
  const item = record(value);
  const kind = requiredText(item['kind'], 40).toUpperCase();
  if (!reviewKinds.has(kind)) return badResponse();
  return {
    id: identifier(item['id']),
    kind,
    title: requiredText(item['title'], 300),
    amount: money(item['amount']),
    reference: optionalText(item['reference'], 120),
    action: optionalText(item['action'], 200),
  };
}

export function parseFinanceReviewQueue(value: unknown): FinanceReviewQueue {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parseReviewItem);
  return { asOf: requiredIso(body['asOf']), items, total: count(body['total']) ?? items.length };
}

export interface FinanceExpense {
  id: string;
  amount: number | null;
  category: string | null;
  description: string | null;
  status: string;
  incurredAt: string | null;
}

export interface FinanceExpensePage {
  items: FinanceExpense[];
  total: number;
}

function parseExpense(value: unknown): FinanceExpense {
  const expense = record(value);
  return {
    id: identifier(expense['id']),
    amount: money(expense['amount']),
    category: optionalText(expense['category'], 120),
    description: optionalText(expense['description'], 300),
    status: requiredText(expense['status'], 60),
    incurredAt: optionalIso(expense['incurredAt']),
  };
}

export function parseFinanceExpensePage(value: unknown): FinanceExpensePage {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parseExpense);
  return { items, total: count(body['total']) ?? items.length };
}

export interface FinancePayable {
  id: string;
  supplier: string;
  outstanding: number | null;
  dueDate: string | null;
  status: string;
  reference: string | null;
}

export interface FinancePayablePage {
  items: FinancePayable[];
  total: number;
  totalOutstanding: number | null;
}

function parsePayable(value: unknown): FinancePayable {
  const payable = record(value);
  return {
    id: identifier(payable['id']),
    supplier: requiredText(payable['supplier'], 200),
    outstanding: money(payable['outstanding']),
    dueDate: optionalIso(payable['dueDate']),
    status: requiredText(payable['status'], 60),
    reference: optionalText(payable['reference'], 120),
  };
}

export function parseFinancePayablePage(value: unknown): FinancePayablePage {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parsePayable);
  return { items, total: count(body['total']) ?? items.length, totalOutstanding: money(body['totalOutstanding']) };
}

export interface FinanceWithdrawal {
  id: string;
  type: string;
  amount: number | null;
  recordedAt: string | null;
  reference: string | null;
}

export interface FinanceWithdrawalPage {
  items: FinanceWithdrawal[];
  total: number;
}

function parseWithdrawal(value: unknown): FinanceWithdrawal {
  const withdrawal = record(value);
  const type = requiredText(withdrawal['type'], 40).toUpperCase();
  if (type !== 'WITHDRAWAL' && type !== 'CONTRIBUTION') return badResponse();
  return {
    id: identifier(withdrawal['id']),
    type,
    amount: money(withdrawal['amount']),
    recordedAt: optionalIso(withdrawal['recordedAt']),
    reference: optionalText(withdrawal['reference'], 120),
  };
}

export function parseFinanceWithdrawalPage(value: unknown): FinanceWithdrawalPage {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parseWithdrawal);
  return { items, total: count(body['total']) ?? items.length };
}
