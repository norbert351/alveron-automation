import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import type { FinanceDailyReport, FinanceMetrics } from '../integrations/alveron/finance.js';
import {
  disabledAdminNotifier, financeAnomalyNotification, type FinanceAnomalyInput, type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_ANOMALY_ENDPOINT = FINANCE_ENDPOINTS.dailyReport;

/**
 * Deterministic anomaly thresholds. All are whole numbers; 0 disables a signal. These are monitoring
 * thresholds over authoritative values, never financial calculations.
 */
export interface FinanceAnomalyThresholds {
  /** Daily operating expenses above this whole-naira value. 0 disables. */
  expenseSpike: number;
  /** Refunds as a percentage of revenue above this value. 0 disables. */
  refundRatePercent: number;
  /** Revenue drop against the previous period, in percent. 0 disables. */
  revenueDropPercent: number;
  /** Reconciliation issues above this count. 0 disables. */
  reconciliationIssues: number;
  /** Supplier payables above this whole-naira value. 0 disables. */
  payableSpike: number;
  /** Missing product-cost items above this count. 0 disables. */
  missingCostItems: number;
}

function nairaLabel(value: number): string {
  return `₦${value.toLocaleString('en-US')}`;
}

/**
 * Pure deterministic detection over authoritative metrics. Exported for tests. No AI, no
 * explanation, no causal claim — a signal is emitted only when a configured threshold is crossed.
 */
export function detectFinanceAnomalies(report: FinanceDailyReport, thresholds: FinanceAnomalyThresholds): FinanceAnomalyInput[] {
  const current: FinanceMetrics = report.current;
  const previous = report.previous;
  const signals: FinanceAnomalyInput[] = [];
  const base = { period: report.period, asOf: report.asOf };

  if (thresholds.expenseSpike > 0 && current.operatingExpenses !== null && current.operatingExpenses > thresholds.expenseSpike) {
    signals.push({ ...base, signal: 'EXPENSE_SPIKE',
      signalLabel: `Operating expenses exceeded ${nairaLabel(thresholds.expenseSpike)}`,
      observed: current.operatingExpenses, threshold: thresholds.expenseSpike });
  }
  if (thresholds.refundRatePercent > 0 && current.refunds !== null && current.revenue !== null && current.revenue > 0) {
    const rate = (current.refunds / current.revenue) * 100;
    if (rate > thresholds.refundRatePercent) {
      signals.push({ ...base, signal: 'REFUND_RATE',
        signalLabel: `Refund rate exceeded ${thresholds.refundRatePercent}% of revenue`,
        observed: Math.round(rate * 10) / 10, threshold: thresholds.refundRatePercent });
    }
  }
  if (thresholds.revenueDropPercent > 0 && current.revenue !== null && previous?.revenue != null && previous.revenue > 0) {
    const drop = ((previous.revenue - current.revenue) / previous.revenue) * 100;
    if (drop > thresholds.revenueDropPercent) {
      signals.push({ ...base, signal: 'REVENUE_DROP',
        signalLabel: `Revenue dropped more than ${thresholds.revenueDropPercent}% vs previous period`,
        observed: Math.round(drop * 10) / 10, threshold: thresholds.revenueDropPercent });
    }
  }
  if (thresholds.reconciliationIssues > 0 && current.reconciliationIssues !== null &&
      current.reconciliationIssues > thresholds.reconciliationIssues) {
    signals.push({ ...base, signal: 'RECONCILIATION_ISSUES',
      signalLabel: `Reconciliation issues exceeded ${thresholds.reconciliationIssues}`,
      observed: current.reconciliationIssues, threshold: thresholds.reconciliationIssues });
  }
  if (thresholds.payableSpike > 0 && current.supplierPayables !== null && current.supplierPayables > thresholds.payableSpike) {
    signals.push({ ...base, signal: 'PAYABLE_SPIKE',
      signalLabel: `Supplier payables exceeded ${nairaLabel(thresholds.payableSpike)}`,
      observed: current.supplierPayables, threshold: thresholds.payableSpike });
  }
  if (thresholds.missingCostItems > 0 && current.missingCostItems !== null &&
      current.missingCostItems > thresholds.missingCostItems) {
    signals.push({ ...base, signal: 'MISSING_COST',
      signalLabel: `Missing product-cost items exceeded ${thresholds.missingCostItems}`,
      observed: current.missingCostItems, threshold: thresholds.missingCostItems });
  }
  if (current.revenue !== null && current.revenue < 0) {
    signals.push({ ...base, signal: 'NEGATIVE_REVENUE',
      signalLabel: 'Revenue was reported as a negative value',
      observed: current.revenue, threshold: null });
  }
  return signals;
}

/**
 * ALVERON - Finance - Anomaly Monitor.
 *
 * Reads the authoritative daily report and raises a WARNING for each deterministic threshold
 * crossing. No AI, no story, no financial recomputation. Deduplicated per
 * `finance-anomaly:<period>:<signal>`, so a condition that persists across polls alerts once per
 * period.
 */
export class FinanceAnomalyMonitorWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly thresholds: FinanceAnomalyThresholds,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-anomaly-monitor', FINANCE_ANOMALY_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A finance anomaly scan is already running.' });
    this.running = true;
    try {
      const report = await this.client.getFinanceDailyReport();
      const signals = detectFinanceAnomalies(report, this.thresholds);
      let notified = 0;
      let duplicates = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const signal of signals) {
        const status = await safeNotify(this.adminNotifications, financeAnomalyNotification(signal, this.timeZone));
        const counts = tally(status);
        notified += counts.notified;
        duplicates += counts.duplicates;
        notificationStatus = status;
      }
      if (!signals.length) {
        return finish({ status: 'noop', notificationStatus: 'DISABLED',
          message: 'No configured anomaly threshold was crossed.' });
      }
      return finish({ status: 'completed', itemsFound: signals.length, notified, duplicates, notificationStatus,
        message: `${signals.length} anomaly signal(s) detected; ${notified} alert(s) sent.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-anomaly-monitor', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Finance data could not be retrieved; no anomaly alert was sent.' });
    } finally { this.running = false; }
  }
}
