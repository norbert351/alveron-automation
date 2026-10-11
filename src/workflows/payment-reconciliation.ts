import { randomUUID } from 'node:crypto';
import type { OrderClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import { isPaid, type Order } from '../integrations/alveron/schemas.js';
import {
  disabledAdminNotifier,
  paymentReconciliationNotification,
  type ReconciliationFinding,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** The only Alveron endpoint this workflow reads. Admin-scoped, read-only. */
export const PAYMENT_RECONCILIATION_ENDPOINT = '/orders';

/** Ceiling on reconciliation alerts per run. */
export const MAX_RECONCILIATION_ALERTS_PER_RUN = 10;

export interface PaymentReconciliationResult {
  runId: string;
  workflow: 'payment-reconciliation';
  status: 'completed' | 'failed' | 'busy';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ordersScanned: number;
  findings: number;
  notified: number;
  duplicates: number;
  suppressedByCap: number;
  results: { orderId: string; code: string; notificationStatus: string }[];
  code?: string;
  message: string;
}

/**
 * Scheduled payment reconciliation.
 *
 * READ-ONLY. This workflow never edits payment rows, never calls Paystack, and never calls a
 * payment endpoint. It inspects the payment state Alveron already exposes on `GET /orders` and
 * raises a human-review alert for the anomalies it can prove from that data:
 *
 *   - VERIFICATION_FAILED            Alveron's own mismatch flag (amount/currency/stock)
 *   - DUPLICATE_PAYMENT              two or more SUCCESS payments on one order
 *   - PROVIDER_PAID_NOT_CONFIRMED    a SUCCESS payment while the order is not paid
 *   - AMOUNT_MISMATCH               a SUCCESS payment whose kobo amount disagrees with order total
 *
 * "Attempt only safe backend-supported reconciliation" cannot be honoured here: Alveron exposes
 * no reconciliation endpoint and automation is forbidden from touching payment state, so the only
 * correct action is to alert. The absence of an automatic fix is intentional, not an oversight.
 *
 * Idempotency: `payment-reconciliation:<orderId>:<code>` in the shared ledger, so a persistent
 * anomaly alerts once and stays quiet across polls.
 */
export class PaymentReconciliationWorkflow {
  private running = false;
  constructor(
    private readonly client: OrderClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<PaymentReconciliationResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const base = {
      runId, workflow: 'payment-reconciliation' as const, endpoint: PAYMENT_RECONCILIATION_ENDPOINT,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const finish = (over: { status: PaymentReconciliationResult['status']; message: string } &
      Omit<Partial<PaymentReconciliationResult>, 'status' | 'message'>): PaymentReconciliationResult => {
      const completedAtMs = this.now();
      return { ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), ordersScanned: 0, findings: 0,
        notified: 0, duplicates: 0, suppressedByCap: 0, results: [], ...over };
    };
    if (this.running) {
      return finish({ status: 'busy', code: 'BUSY', message: 'A reconciliation pass is already running.' });
    }
    this.running = true;
    try {
      const orders = await this.client.getOrders();
      const results: PaymentReconciliationResult['results'] = [];
      const seen = new Set<string>();
      let findings = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;

      for (const order of orders) {
        for (const finding of detectFindings(order)) {
          const identity = `${finding.orderId}:${finding.code}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          findings += 1;
          if (notified >= MAX_RECONCILIATION_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
          let notificationStatus: AdminNotificationResult['status'];
          try {
            notificationStatus = (await this.adminNotifications.notify(
              paymentReconciliationNotification(finding))).status;
          } catch {
            notificationStatus = 'FAILED';
          }
          if (notificationStatus === 'SUCCESS') notified += 1;
          else if (notificationStatus === 'SKIPPED') duplicates += 1;
          results.push({ orderId: finding.orderId, code: finding.code, notificationStatus });
        }
      }
      return finish({ status: 'completed', ordersScanned: orders.length, findings, notified, duplicates,
        suppressedByCap, results,
        message: `Reconciliation scanned ${orders.length} order(s) read-only; ${findings} anomaly finding(s), ${notified} alert(s).` });
    } catch (error) {
      return finish({ status: 'failed', code: safeCode(error),
        message: 'Orders could not be read; reconciliation produced no findings.' });
    } finally { this.running = false; }
  }
}

/**
 * Pure detection over an order Alveron already returned. Exported for tests so the anomaly rules
 * are verifiable without a network call.
 */
export function detectFindings(order: Order): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  const base = { orderId: order.id, orderNumber: order.order_number, paymentStatus: order.payment_status };
  const successful = order.payments.filter(payment => payment.status.toUpperCase() === 'SUCCESS');

  if (order.payment_status.toUpperCase() === 'VERIFICATION_FAILED') {
    findings.push({ ...base, code: 'VERIFICATION_FAILED',
      detail: 'Alveron flagged this payment as verification-failed (amount/currency/stock mismatch).' });
  }
  if (successful.length > 1) {
    findings.push({ ...base, code: 'DUPLICATE_PAYMENT',
      detail: `${successful.length} successful payments recorded for one order.` });
  }
  if (successful.length > 0 && !isPaid(order.payment_status) && order.status.toLowerCase() === 'pending'
      && order.payment_status.toUpperCase() !== 'VERIFICATION_FAILED') {
    findings.push({ ...base, code: 'PROVIDER_PAID_NOT_CONFIRMED',
      detail: 'A successful payment exists but the order is still pending.' });
  }
  for (const payment of successful) {
    // Alveron stores payments in kobo (NGN × 100). A mismatch against the order total is a signal,
    // never something automation may correct.
    if (payment.currency === 'NGN' && payment.amount !== order.total * 100) {
      findings.push({ ...base, code: 'AMOUNT_MISMATCH',
        detail: `Successful payment amount disagrees with the order total for reference ${payment.provider_reference}.` });
      break;
    }
  }
  return findings;
}
