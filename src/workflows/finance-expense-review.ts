import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import { disabledAdminNotifier, financeExpenseReviewNotification, type AdminNotifier } from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_EXPENSE_REVIEW_ENDPOINT = FINANCE_ENDPOINTS.pendingReviewExpenses;

/** Ceiling on expense-review alerts per run. */
export const MAX_FINANCE_EXPENSE_ALERTS_PER_RUN = 25;

/**
 * ALVERON - Finance - Expense Review.
 *
 * Reads Alveron's list of expenses awaiting review and alerts the admin. It NEVER approves or edits
 * an expense; approval stays a human action in the Alveron dashboard. Deduplicated per
 * `finance-expense-review:<expenseId>`, so a persistent pending expense alerts once.
 */
export class FinanceExpenseReviewWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-expense-review', FINANCE_EXPENSE_REVIEW_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'An expense-review pass is already running.' });
    this.running = true;
    try {
      const page = await this.client.getPendingReviewExpenses();
      const seen = new Set<string>();
      let itemsFound = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const expense of page.items) {
        if (seen.has(expense.id)) continue;
        seen.add(expense.id);
        itemsFound += 1;
        if (notified + duplicates >= MAX_FINANCE_EXPENSE_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
        const status = await safeNotify(this.adminNotifications, financeExpenseReviewNotification(expense, this.timeZone));
        const counts = tally(status);
        notified += counts.notified;
        duplicates += counts.duplicates;
        notificationStatus = status;
      }
      return finish({ status: 'completed', itemsFound, notified, duplicates, suppressedByCap, notificationStatus,
        message: `${page.items.length} expense(s) awaiting review; ${notified} alert(s) sent.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-expense-review', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Expense-review data could not be retrieved; no review alert was sent.' });
    } finally { this.running = false; }
  }
}
