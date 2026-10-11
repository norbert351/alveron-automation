import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import {
  disabledAdminNotifier, financeBusinessDate, financeWeeklyReportNotification, type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_WEEKLY_ENDPOINT = FINANCE_ENDPOINTS.weeklyReport;

/**
 * ALVERON - Finance - Weekly Report.
 *
 * Reads Alveron's authoritative weekly finance report (revenue, COGS, profit, expenses, product
 * contribution, largest expense categories) and posts a single digest. Highlights only report
 * changes that the data supports — no causal story is invented.
 *
 * Idempotent per authoritative period (`finance-weekly-report:<period>`).
 */
export class FinanceWeeklyReportWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-weekly-report', FINANCE_WEEKLY_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A weekly finance report is already running.' });
    this.running = true;
    try {
      const report = await this.client.getFinanceWeeklyReport();
      const status = await safeNotify(this.adminNotifications, financeWeeklyReportNotification(report, this.timeZone));
      const counts = tally(status);
      const period = financeBusinessDate(report.period.start ?? report.asOf, this.timeZone);
      return finish({ status: 'completed', itemsFound: 1, ...counts, notificationStatus: status,
        message: `Weekly finance report for ${period} processed from Alveron.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-weekly-report', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Finance data could not be retrieved; no weekly report was sent.' });
    } finally { this.running = false; }
  }
}
