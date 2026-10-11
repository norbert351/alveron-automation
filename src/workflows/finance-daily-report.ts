import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import {
  disabledAdminNotifier, financeBusinessDate, financeDailyReportNotification, type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_DAILY_ENDPOINT = FINANCE_ENDPOINTS.dailyReport;

/**
 * ALVERON - Finance - Daily Report.
 *
 * Reads Alveron's authoritative end-of-day finance report and posts it to the admin channel. Every
 * figure is taken verbatim; the only computed values are explicitly-labelled presentation changes
 * against the previous day. If the report cannot be retrieved, no numbers are invented — a
 * CRITICAL automation-health alert is sent and the run is reported failed.
 *
 * Idempotent per authoritative period (`finance-daily-report:<period>`), so a retry or an
 * overlapping schedule cannot double-post the same day's report.
 */
export class FinanceDailyReportWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-daily-report', FINANCE_DAILY_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A daily finance report is already running.' });
    this.running = true;
    try {
      const report = await this.client.getFinanceDailyReport();
      const status = await safeNotify(this.adminNotifications, financeDailyReportNotification(report, this.timeZone));
      const counts = tally(status);
      const period = financeBusinessDate(report.period.start ?? report.asOf, this.timeZone);
      return finish({ status: 'completed', itemsFound: 1, ...counts, notificationStatus: status,
        message: `Daily finance report for ${period} processed from Alveron.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-daily-report', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Finance data could not be retrieved; no daily report was sent.' });
    } finally { this.running = false; }
  }
}
