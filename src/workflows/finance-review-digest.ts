import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import {
  disabledAdminNotifier,
  financeReviewDigestNotification,
  ownerWithdrawalNotification,
  type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_REVIEW_DIGEST_ENDPOINT = FINANCE_ENDPOINTS.reviewQueue;
export const FINANCE_WITHDRAWALS_ENDPOINT = FINANCE_ENDPOINTS.withdrawals;

/**
 * ALVERON - Finance - Review Digest.
 *
 * Aggregates the authoritative review queue (payment issues, expense reviews, supplier issues,
 * missing costs, refunds, owner transactions) into ONE concise admin message, instead of one alert
 * per item. Owner withdrawals/contributions are additionally surfaced from `/withdrawals`; they are a
 * financial review event and are never blocked or reclassified as operating expenses.
 *
 * The digest is deduplicated by a hash of the current queue's item ids, so re-running with an
 * unchanged queue is a no-op while a changed queue produces a new digest. If the authoritative
 * review queue cannot be read, the run fails and a finance-unavailable alert is sent; the optional
 * withdrawals read is best-effort and its failure is recorded without discarding a valid digest.
 */
export class FinanceReviewDigestWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-review-digest', FINANCE_REVIEW_DIGEST_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A finance review digest is already running.' });
    this.running = true;
    try {
      const queue = await this.client.getFinanceReviewQueue();

      // Best-effort owner-transaction surface; its absence must not discard a valid review queue.
      let ownerTransactions = 0;
      let ownerAlerts = 0;
      let ownerCode: string | undefined;
      try {
        const withdrawals = await this.client.getOwnerWithdrawals();
        for (const withdrawal of withdrawals.items) {
          ownerTransactions += 1;
          const status = await safeNotify(this.adminNotifications, ownerWithdrawalNotification(withdrawal, this.timeZone));
          ownerAlerts += tally(status).notified;
        }
      } catch (error) {
        ownerCode = safeCode(error);
      }

      if (!queue.items.length) {
        return finish({ status: 'noop', notificationStatus: 'DISABLED',
          ...(ownerCode ? { code: ownerCode } : {}),
          message: ownerTransactions
            ? `No review-queue items; ${ownerAlerts} owner-transaction alert(s) sent.`
            : 'No finance items require attention.' });
      }

      const status = await safeNotify(this.adminNotifications, financeReviewDigestNotification(queue, this.timeZone));
      const counts = tally(status);
      return finish({ status: 'completed', itemsFound: queue.total, notified: counts.notified + ownerAlerts,
        duplicates: counts.duplicates, notificationStatus: status,
        ...(ownerCode ? { code: ownerCode } : {}),
        message: `Review digest covers ${queue.total} item(s); ${counts.notified} digest alert(s), ${ownerAlerts} owner-transaction alert(s).` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-review-digest', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Finance review data could not be retrieved; no digest was sent.' });
    } finally { this.running = false; }
  }
}
