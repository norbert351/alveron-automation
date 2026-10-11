import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import { disabledAdminNotifier, financeReconciliationNotification, type AdminNotifier } from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_RECONCILIATION_ENDPOINT = FINANCE_ENDPOINTS.reconciliation;

/** Ceiling on reconciliation alerts per run, so a large mismatch set cannot flood the admin chat. */
export const MAX_FINANCE_RECONCILIATION_ALERTS_PER_RUN = 10;

/**
 * ALVERON - Finance - Reconciliation.
 *
 * Reads Alveron's authoritative reconciliation surface — mismatches between order/payment records
 * and the approved payment integration (paid-but-unreconciled, payment-without-order, amount
 * mismatch, duplicate reference, refund mismatch). READ-ONLY: it never edits payment or order state.
 *
 * Findings are deduplicated per `finance-reconciliation:<issueId>:<code>`, so a persistent mismatch
 * alerts once and stays quiet; a changed finding re-alerts.
 *
 * This is complementary to the order-list-derived `payment-reconciliation` workflow: this one
 * consumes Alveron's own reconciliation classification (the authoritative view) once it is served.
 */
export class FinanceReconciliationWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-reconciliation', FINANCE_RECONCILIATION_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A finance reconciliation pass is already running.' });
    this.running = true;
    try {
      const report = await this.client.getFinanceReconciliation();
      const seen = new Set<string>();
      let itemsFound = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const issue of report.issues) {
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        itemsFound += 1;
        if (notified + duplicates >= MAX_FINANCE_RECONCILIATION_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
        const status = await safeNotify(this.adminNotifications, financeReconciliationNotification(issue));
        const counts = tally(status);
        notified += counts.notified;
        duplicates += counts.duplicates;
        notificationStatus = status;
      }
      return finish({ status: 'completed', itemsFound, notified, duplicates, suppressedByCap, notificationStatus,
        message: `Reconciliation read ${report.issues.length} issue(s) from Alveron; ${notified} alert(s) sent, ${duplicates} already notified.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-reconciliation', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Reconciliation data could not be retrieved; no review alert was sent.' });
    } finally { this.running = false; }
  }
}
