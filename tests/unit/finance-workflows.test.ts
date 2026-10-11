import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinanceClient } from '../../src/integrations/alveron/client.js';
import { AppError } from '../../src/integrations/alveron/errors.js';
import {
  parseFinanceDailyReport, parseFinanceExpensePage, parseFinanceNativeOverview, parseFinanceOverview,
  parseFinancePayablePage, parseFinanceReconciliation, parseFinanceReviewQueue, parseFinanceWeeklyReport,
  parseFinanceWithdrawalPage,
} from '../../src/integrations/alveron/finance.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import {
  financeBusinessDate, financeDailyReportNotification, financeWeeklyReportNotification,
  financeUnavailableNotification, renderTelegramHtml, type AdminNotificationProvider,
} from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { FinanceDailyReportWorkflow } from '../../src/workflows/finance-daily-report.js';
import { FinanceWeeklyReportWorkflow } from '../../src/workflows/finance-weekly-report.js';
import { FinanceReconciliationWorkflow } from '../../src/workflows/finance-reconciliation.js';
import { FinanceExpenseReviewWorkflow } from '../../src/workflows/finance-expense-review.js';
import { FinanceSupplierPayablesWorkflow, needsAttention } from '../../src/workflows/finance-supplier-payables.js';
import { FinanceReviewDigestWorkflow } from '../../src/workflows/finance-review-digest.js';
import { FinanceAnomalyMonitorWorkflow, detectFinanceAnomalies } from '../../src/workflows/finance-anomaly-monitor.js';

const metrics = (over: Record<string, unknown> = {}) => ({
  orders: 10, revenue: 500000, cogs: 300000, grossProfit: 200000, operatingExpenses: 40000,
  paymentFees: 5000, refunds: 10000, netProfit: 155000, supplierPayables: 120000,
  reviewItems: 1, reconciliationIssues: 0, missingCostItems: 0, ...over,
});

const dailyReport = (over: Record<string, unknown> = {}) => parseFinanceDailyReport({
  asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN',
  period: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T23:59:59.000Z' },
  current: metrics(), previous: metrics({ revenue: 400000, operatingExpenses: 25000 }), ...over,
});

const service = (
  ledger: SqliteLedger,
  send: (notification: { resourceId: string; eventKey: string; kind: string }) => Promise<{ messageId: string; simulated: boolean }>,
) => {
  const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true, send };
  return new AdminNotificationService(ledger, provider, createLogger('silent'));
};

/** A FinanceClient whose methods reject unless overridden; proves a workflow only reads its own endpoint. */
const financeClient = (over: Partial<FinanceClient>): FinanceClient => ({
  getFinanceOverview: async () => { throw new Error('not used'); },
  getFinanceDailyReport: async () => { throw new Error('not used'); },
  getFinanceWeeklyReport: async () => { throw new Error('not used'); },
  getFinanceReconciliation: async () => { throw new Error('not used'); },
  getPendingReviewExpenses: async () => { throw new Error('not used'); },
  getSupplierPayables: async () => { throw new Error('not used'); },
  getFinanceReviewQueue: async () => { throw new Error('not used'); },
  getOwnerWithdrawals: async () => { throw new Error('not used'); },
  ...over,
});

test('finance parsing accepts a strict envelope and rejects malformed shapes', () => {
  assert.equal(parseFinanceOverview({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', period: null,
    ...metrics() }).revenue, 500000);
  // Absent metrics are null, never zero.
  const sparse = parseFinanceOverview({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN' });
  assert.equal(sparse.revenue, null);
  assert.equal(sparse.orders, null);
  // Wrong currency, non-integer money, and a malformed issue code must all fail closed.
  assert.throws(() => parseFinanceOverview({ asOf: '2026-10-04T09:00:00.000Z', currency: 'USD' }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceDailyReport({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: { revenue: 1.5 } }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceReconciliation({ asOf: '2026-10-04T09:00:00.000Z', issues: [{ id: 'x', code: 'lowercase' }] }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceReviewQueue({ asOf: '2026-10-04T09:00:00.000Z', items: [{ id: 'x', kind: 'NOPE', title: 't' }] }), /INVALID_RESPONSE/);
  // Missing required arrays, and a non-integer metric, both fail closed.
  assert.throws(() => parseFinanceWeeklyReport({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: {} }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceExpensePage({ items: [{ id: 'x', amount: 1.5, status: 'pending_review' }] }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinancePayablePage({ items: [{ id: 'x', supplier: '', status: 'due' }] }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceWithdrawalPage({ items: [{ id: 'x', type: 'TRANSFER', amount: 1 }] }), /INVALID_RESPONSE/);
  // An unknown capital status fails the whole finance response closed.
  assert.throws(() => parseFinanceDailyReport({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN',
    current: {}, capital: { status: 'guessed' } }), /INVALID_RESPONSE/);
  // A non-integer estimated cash fails closed rather than being silently rounded.
  assert.throws(() => parseFinanceDailyReport({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN',
    current: {}, estimatedCash: 1.5 }), /INVALID_RESPONSE/);
});

test('the served native overview shape is parsed verbatim and fails closed on malformed values', () => {
  const native = parseFinanceNativeOverview({
    period: { key: 'this_month', label: 'This month', from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.000Z' },
    summary: { currency: 'NGN', transactionCount: 12, revenueMinor: 5000000, cogsMinor: 3000000 },
    cash: { currency: 'NGN', estimatedCashMinor: 51200000, isEstimate: true },
    safeWithdrawal: { estimatedSafeWithdrawalMinor: 37500000, note: 'estimate' },
    ownerCapital: { currency: 'NGN', openingCapitalStatus: 'not_entered', openingCapitalMinor: 0 },
    payablesOutstandingMinor: 7400000,
    reviewRequired: 3,
  });
  // Minor units are preserved exactly (no conversion, no rounding, no derivation).
  assert.equal(native.summary['revenueMinor'], 5000000);
  assert.equal(native.cash['estimatedCashMinor'], 51200000);
  assert.equal(native.ownerCapital['openingCapitalStatus'], 'not_entered');
  assert.equal(native.payablesOutstandingMinor, 7400000);
  assert.equal(native.reviewRequired, 3);
  // A non-integer minor value fails the whole native overview closed rather than being rounded.
  assert.throws(() => parseFinanceNativeOverview({ summary: { revenueMinor: 1.5 } }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceNativeOverview({ summary: { revenueMinor: 'lots' } }), /INVALID_RESPONSE/);
});

test('cash and capital are parsed from the contract and default to null when absent', () => {
  const report = parseFinanceDailyReport({
    asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: metrics(), previous: null,
    estimatedCash: 512000,
    capital: { status: 'not_entered', openingCapital: 0, contributions: 0, withdrawals: 0, netMovement: 0 },
    workingCapital: { estimatedCash: 512000, supplierPayablesOutstanding: 74000,
      upcomingSupplierPayments: 60000, overdueSupplierPayments: 14000, pendingRefunds: 8000,
      otherKnownCommitments: 45000, reserves: 10000, estimatedSafeToWithdraw: 375000, isEstimate: true },
  });
  assert.equal(report.estimatedCash, 512000);
  assert.equal(report.capital?.status, 'not_entered');
  assert.equal(report.workingCapital?.estimatedSafeToWithdraw, 375000);
  assert.equal(report.workingCapital?.isEstimate, true);
  // Absent context is null, never zero.
  const sparse = parseFinanceDailyReport({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: {} });
  assert.equal(sparse.estimatedCash, null);
  assert.equal(sparse.capital, null);
  assert.equal(sparse.workingCapital, null);
});

test('the daily report renders estimated cash and "Not entered" capital, never a fake ₦0', () => {
  const notEntered = parseFinanceDailyReport({
    asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: metrics(), previous: null,
    estimatedCash: 512000,
    capital: { status: 'not_entered', openingCapital: 0, contributions: 0, withdrawals: 0, netMovement: 0 },
  });
  const rendered = renderTelegramHtml(financeDailyReportNotification(notEntered, 'Africa/Lagos'));
  assert.match(rendered, /Estimated Cash/);
  assert.match(rendered, /₦512,000/);
  assert.match(rendered, /Capital/);
  assert.match(rendered, /Not entered/);
  // The capital line specifically must not read as a fabricated ₦0.
  const capitalSection = rendered.split('Capital')[1] ?? '';
  assert.doesNotMatch(capitalSection, /₦0/);

  const entered = parseFinanceDailyReport({
    asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: metrics(), previous: null,
    estimatedCash: 512000,
    capital: { status: 'entered', openingCapital: 100000, contributions: 100000, withdrawals: 0, netMovement: 100000 },
  });
  const enteredRendered = renderTelegramHtml(financeDailyReportNotification(entered, 'Africa/Lagos'));
  assert.match(enteredRendered, /₦100,000/);
  assert.doesNotMatch(enteredRendered, /Not entered/);
});

test('the daily finance report uses authoritative values and labels derived changes', () => {
  const rendered = renderTelegramHtml(financeDailyReportNotification(dailyReport(), 'Africa/Lagos'));
  assert.match(rendered, /ALVERON DAILY FINANCE/);
  assert.match(rendered, /₦500,000/);
  assert.match(rendered, /Revenue change \(derived\)/);
  assert.match(rendered, /\+25%/);
  // A not-provided field is shown honestly, never as zero.
  const sparse = renderTelegramHtml(financeDailyReportNotification(parseFinanceDailyReport({
    asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: {}, previous: null,
  }), 'Africa/Lagos'));
  assert.match(sparse, /not provided/);
});

test('weekly report highlights only data-supported facts', () => {
  const report = parseFinanceWeeklyReport({
    asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN',
    period: { start: '2026-09-28T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' },
    current: metrics({ revenue: 2000000 }), previous: metrics({ revenue: 1600000 }),
    productProfitability: [{ title: 'Premium Polo', contributionProfit: 300000, units: 40 }],
    largestExpenseCategories: [{ category: 'Marketing', amount: 90000 }],
  });
  const rendered = renderTelegramHtml(financeWeeklyReportNotification(report, 'Africa/Lagos'));
  assert.match(rendered, /ALVERON WEEKLY FINANCE/);
  assert.match(rendered, /Premium Polo/);
  assert.match(rendered, /Marketing/);
  assert.match(rendered, /Gross margin \(derived\)/);
});

test('daily report workflow is idempotent per authoritative period and survives read failure', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const client = financeClient({ getFinanceDailyReport: async () => dailyReport() });
    const workflow = new FinanceDailyReportWorkflow(client, notifications);
    assert.equal((await workflow.run()).notified, 1);
    assert.equal((await workflow.run()).duplicates, 1);
    assert.equal(sends, 1);

    const failing = financeClient({ getFinanceDailyReport: async () => { throw new AppError('FINANCE_ENDPOINT_UNAVAILABLE', 404); } });
    const failed = await new FinanceDailyReportWorkflow(failing, notifications).run();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'FINANCE_ENDPOINT_UNAVAILABLE');
    // A CRITICAL finance-unavailable alert is sent, but it must not invent numbers.
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('finance-unavailable notification never fabricates amounts and is critical', () => {
  const rendered = renderTelegramHtml(financeUnavailableNotification('finance-daily-report', 'FINANCE_ENDPOINT_UNAVAILABLE'));
  assert.match(rendered, /FINANCE AUTOMATION ERROR/);
  assert.match(rendered, /FINANCE_ENDPOINT_UNAVAILABLE/);
  assert.doesNotMatch(rendered, /₦/);
});

test('finance reconciliation is read-only, deduplicated, and capped', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const report = parseFinanceReconciliation({
      asOf: '2026-10-04T09:00:00.000Z', issueCount: 2,
      issues: [
        { id: 'issue-1', orderNumber: 1042, code: 'AMOUNT_MISMATCH', expected: 68000, actual: 66000, reference: 'PAY-XXXX1234' },
        { id: 'issue-2', orderNumber: 1043, code: 'DUPLICATE_PAYMENT', expected: 5000, actual: 10000 },
      ],
    });
    const workflow = new FinanceReconciliationWorkflow(financeClient({ getFinanceReconciliation: async () => report }), notifications);
    const first = await workflow.run();
    assert.equal(first.itemsFound, 2);
    assert.equal(first.notified, 2);
    const second = await workflow.run();
    assert.equal(second.notified, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('expense review alerts on pending expenses and never approves', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const kinds: string[] = [];
    const notifications = service(ledger, async (notification) => { kinds.push(notification.kind); return { messageId: '1', simulated: false }; });
    const page = parseFinanceExpensePage({ total: 1, items: [
      { id: 'exp-1', amount: 25000, category: null, description: 'Supplier transport', status: 'pending_review' },
    ] });
    const first = await new FinanceExpenseReviewWorkflow(financeClient({ getPendingReviewExpenses: async () => page }), notifications).run();
    assert.equal(first.notified, 1);
    assert.deepEqual(kinds, ['FINANCE_EXPENSE_REVIEW']);
    const second = await new FinanceExpenseReviewWorkflow(financeClient({ getPendingReviewExpenses: async () => page }), notifications).run();
    assert.equal(second.duplicates, 1);
    assert.equal(kinds.length, 1);
  } finally { ledger.close(); }
});

test('supplier payables policy flags due/overdue/large and deduplicates per status', async () => {
  assert.equal(needsAttention('overdue', 100, 0), true);
  assert.equal(needsAttention('partially_paid', 100, 0), true);
  assert.equal(needsAttention('paid', 100, 0), false);
  assert.equal(needsAttention('pending', 500000, 100000), true);
  assert.equal(needsAttention('pending', 50, 100000), false);

  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const page = parseFinancePayablePage({ totalOutstanding: 120000, total: 1, items: [
      { id: 'pay-1', supplier: 'ABC Supplier', outstanding: 120000, dueDate: '2026-10-06T00:00:00.000Z', status: 'due_soon' },
    ] });
    const workflow = new FinanceSupplierPayablesWorkflow(financeClient({ getSupplierPayables: async () => page }), { largePayableThreshold: 0 }, notifications);
    assert.equal((await workflow.run()).notified, 1);
    assert.equal((await workflow.run()).duplicates, 1);
    assert.equal(sends, 1);
  } finally { ledger.close(); }
});

test('owner transactions are surfaced by the digest, not blocked, and digest dedupes by queue', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const kinds: string[] = [];
    const notifications = service(ledger, async (notification) => { kinds.push(notification.kind); return { messageId: '1', simulated: false }; });
    const queue = parseFinanceReviewQueue({ asOf: '2026-10-04T09:00:00.000Z', total: 3, items: [
      { id: 'r1', kind: 'PAYMENT', title: 'Payment mismatch — Order #1042', amount: 68000 },
      { id: 'r2', kind: 'EXPENSE', title: 'Uncategorized expense', amount: 25000 },
      { id: 'r3', kind: 'SUPPLIER', title: 'Supplier payable overdue', amount: 120000 },
    ] });
    const withdrawals = parseFinanceWithdrawalPage({ total: 1, items: [
      { id: 'w1', type: 'WITHDRAWAL', amount: 100000, recordedAt: '2026-10-04T09:00:00.000Z' },
    ] });
    const client = financeClient({ getFinanceReviewQueue: async () => queue, getOwnerWithdrawals: async () => withdrawals });
    const first = await new FinanceReviewDigestWorkflow(client, notifications).run();
    assert.equal(first.itemsFound, 3);
    assert.ok(kinds.includes('FINANCE_REVIEW_DIGEST'));
    assert.ok(kinds.includes('OWNER_WITHDRAWAL'));
    const digestSends = kinds.filter(kind => kind === 'FINANCE_REVIEW_DIGEST').length;
    await new FinanceReviewDigestWorkflow(client, notifications).run();
    assert.equal(kinds.filter(kind => kind === 'FINANCE_REVIEW_DIGEST').length, digestSends);
  } finally { ledger.close(); }
});

test('anomaly detection is deterministic and threshold-gated', () => {
  const thresholds = { expenseSpike: 30000, refundRatePercent: 5, revenueDropPercent: 10, reconciliationIssues: 0, payableSpike: 0, missingCostItems: 0 };
  const report = dailyReport();
  const signals = detectFinanceAnomalies(report, thresholds);
  const codes = signals.map(s => s.signal).sort();
  // expenses 40000 > 30000, refunds 10000/500000 = 2% (below 5%), revenue up (no drop)
  assert.deepEqual(codes, ['EXPENSE_SPIKE']);

  const disabled = detectFinanceAnomalies(report, { expenseSpike: 0, refundRatePercent: 0, revenueDropPercent: 0, reconciliationIssues: 0, payableSpike: 0, missingCostItems: 0 });
  assert.deepEqual(disabled, []);

  const negative = detectFinanceAnomalies(dailyReport({ current: metrics({ revenue: -5 }) }), thresholds);
  assert.ok(negative.some(s => s.signal === 'NEGATIVE_REVENUE'));
});

test('anomaly monitor alerts once per period and reports a clean noop', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const thresholds = { expenseSpike: 30000, refundRatePercent: 0, revenueDropPercent: 0, reconciliationIssues: 0, payableSpike: 0, missingCostItems: 0 };
    const client = financeClient({ getFinanceDailyReport: async () => dailyReport() });
    const workflow = new FinanceAnomalyMonitorWorkflow(client, thresholds, notifications);
    assert.equal((await workflow.run()).notified, 1);
    assert.equal((await workflow.run()).duplicates, 1);
    assert.equal(sends, 1);

    const quiet = new FinanceAnomalyMonitorWorkflow(client,
      { ...thresholds, expenseSpike: 0 }, notifications).run();
    assert.equal((await quiet).status, 'noop');
  } finally { ledger.close(); }
});

test('finance period keys and report labels use the finance-timezone business date, not the UTC slice', async () => {
  // Alveron's daily period begins at midnight Africa/Lagos = 23:00Z on the previous UTC day.
  assert.equal(financeBusinessDate('2026-10-03T23:00:00.000Z', 'Africa/Lagos'), '2026-10-04');
  assert.equal(financeBusinessDate('2026-10-03T00:00:00.000Z', 'Africa/Lagos'), '2026-10-03');
  assert.equal(financeBusinessDate(null, 'Africa/Lagos'), 'unknown');

  const report = dailyReport({
    period: { start: '2026-10-03T23:00:00.000Z', end: '2026-10-04T23:00:00.000Z' },
  });
  assert.equal(financeDailyReportNotification(report, 'Africa/Lagos').eventKey, 'finance-daily-report:2026-10-04');

  const ledger = new SqliteLedger(':memory:');
  try {
    const result = await new FinanceDailyReportWorkflow(
      financeClient({ getFinanceDailyReport: async () => report }),
      service(ledger, async () => ({ messageId: '1', simulated: true })),
      'Africa/Lagos',
    ).run();
    assert.match(result.message, /for 2026-10-04 processed/);
  } finally { ledger.close(); }
});

test('a Telegram failure never fails a finance workflow', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => { throw new NotificationNotSent(); });
    const result = await new FinanceWeeklyReportWorkflow(
      financeClient({ getFinanceWeeklyReport: async () => parseFinanceWeeklyReport({
        asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN', current: metrics(), previous: null,
        productProfitability: [], largestExpenseCategories: [],
      }) }), notifications,
    ).run();
    assert.equal(result.status, 'completed');
    assert.equal(result.notified, 0);
  } finally { ledger.close(); }
});
