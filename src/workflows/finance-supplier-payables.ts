import { FINANCE_ENDPOINTS, type FinanceClient } from '../integrations/alveron/client.js';
import { disabledAdminNotifier, financePayableNotification, type AdminNotifier } from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

export const FINANCE_PAYABLES_ENDPOINT = FINANCE_ENDPOINTS.supplierPayables;

/** Ceiling on supplier-payable alerts per run. */
export const MAX_FINANCE_PAYABLE_ALERTS_PER_RUN = 25;

/**
 * Statuses Alveron may report that always warrant an admin nudge. `paid`/`settled` are excluded.
 */
const ATTENTION_STATUSES = new Set(['due_soon', 'due', 'overdue', 'partially_paid', 'partial', 'review']);

export interface SupplierPayablePolicy {
  /** An outstanding balance at or above this whole-naira value is "unusually large". 0 disables. */
  largePayableThreshold: number;
}

/**
 * ALVERON - Finance - Supplier Payables.
 *
 * Reads Alveron's authoritative outstanding payables and alerts the admin for those that need
 * attention: due soon, overdue, partially paid, or unusually large (a configurable deterministic
 * threshold). It never moves money and never settles a payable. Deduplicated per
 * `finance-payable:<id>:<status>`, so a status change re-alerts while an unchanged item stays quiet.
 */
export class FinanceSupplierPayablesWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceClient,
    private readonly policy: SupplierPayablePolicy,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-supplier-payables', FINANCE_PAYABLES_ENDPOINT, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A supplier-payables pass is already running.' });
    this.running = true;
    try {
      const page = await this.client.getSupplierPayables();
      const seen = new Set<string>();
      let itemsFound = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const payable of page.items) {
        if (payable.outstanding !== null && payable.outstanding <= 0) continue;
        if (!needsAttention(payable.status, payable.outstanding, this.policy.largePayableThreshold)) continue;
        const identity = `${payable.id}:${payable.status.toLowerCase()}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        itemsFound += 1;
        if (notified + duplicates >= MAX_FINANCE_PAYABLE_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
        const status = await safeNotify(this.adminNotifications, financePayableNotification(payable, this.timeZone));
        const counts = tally(status);
        notified += counts.notified;
        duplicates += counts.duplicates;
        notificationStatus = status;
      }
      return finish({ status: 'completed', itemsFound, notified, duplicates, suppressedByCap, notificationStatus,
        message: `${page.items.length} payable(s) read from Alveron; ${notified} alert(s) sent.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-supplier-payables', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Supplier-payables data could not be retrieved; no alert was sent.' });
    } finally { this.running = false; }
  }
}

/**
 * Pure attention rule. Exported so the deterministic policy is testable without a network call.
 */
export function needsAttention(status: string, outstanding: number | null, largeThreshold: number): boolean {
  if (ATTENTION_STATUSES.has(status.trim().toLowerCase())) return true;
  return largeThreshold > 0 && outstanding !== null && outstanding >= largeThreshold;
}
