import { randomUUID } from 'node:crypto';
import type { OrderClient } from '../integrations/alveron/client.js';
import { validateConfirmation, validatePaidOrder } from '../integrations/alveron/schemas.js';
import { classifyFailure, safeCode, type FailureCategory } from '../integrations/alveron/errors.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import type { EmailProvider } from '../providers/email/index.js';
import {
  disabledAdminNotifier,
  paidOrderNotification,
  paymentFailureNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';
import { NotificationRunner } from './notification-runner.js';

const emptyAdminSummary = {
  attempted: 0, delivered: 0, skipped: 0, failed: 0, pending: 0, disabled: 0,
};

type PaidOrderResultItem = {
  orderId: string; status: string; reason?: string; category?: FailureCategory; simulated?: boolean;
};

export interface PaidOrderRunResult {
  runId: string;
  status: 'busy' | 'partial_failure' | 'completed';
  discovered: number; eligible: number; processed: number; skipped: number; failed: number;
  /** Present only when the run failed, so n8n can classify without parsing reasons. */
  failureCategory?: FailureCategory;
  results: PaidOrderResultItem[];
  adminNotifications: {
    attempted: number; delivered: number; skipped: number; failed: number; pending: number; disabled: number;
  };
}

/**
 * Most-actionable first. Used to collapse several per-order failures into the single category the
 * n8n error workflow classifies on, so an unconfigured channel is never hidden behind a transient one.
 */
const categoryPriority: readonly FailureCategory[] = [
  'CONFIGURATION_ERROR', 'AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR', 'LEDGER_ERROR',
  'VALIDATION_FAILED', 'ALVERON_SERVER_ERROR', 'NETWORK_ERROR', 'RATE_LIMITED', 'INVALID_RESPONSE', 'UNKNOWN_ERROR',
];

/** A safe, actionable category for a failure that did not carry one (a raw AppError or ledger gap). */
function reasonCategory(reason: string, category?: FailureCategory): FailureCategory {
  if (category && category !== 'UNKNOWN_ERROR') return category;
  if (reason.startsWith('CONFIG_')) return 'CONFIGURATION_ERROR';
  if (reason === 'CUSTOMER_EMAIL_MISSING' || reason === 'VALIDATION_FAILED') return 'VALIDATION_FAILED';
  if (reason === 'ALVERON_API_FAILURE') return 'ALVERON_SERVER_ERROR';
  if (reason === 'LEDGER_FAILURE' || reason === 'LEDGER_ERROR') return 'LEDGER_ERROR';
  if (reason === 'RATE_LIMITED') return 'RATE_LIMITED';
  return 'UNKNOWN_ERROR';
}

function pickFailureCategory(results: readonly { status: string; category?: FailureCategory }[]): FailureCategory | undefined {
  const failed = results.filter(result => result.status === 'failed' && result.category);
  if (!failed.length) return undefined;
  return [...categoryPriority].find(category => failed.some(result => result.category === category));
}

/**
 * A runner returned `SKIPPED`, which only happens when the ledger claim was refused. If the stored
 * record is `SUCCESS` the channel is already delivered (returns null). If it is `FAILED` the claim is
 * retry-capped, so report the *persisted* failure category — an exhausted unconfigured channel must
 * stay `CONFIGURATION_ERROR`, never degrade to a generic ledger error. A missing record is a real gap.
 */
function exhaustedFailure(ledger: Ledger, orderId: string, key: string): PaidOrderResultItem | null {
  const entry = ledger.get(key);
  if (entry?.status === 'SUCCESS') return null;
  if (entry?.status === 'FAILED') {
    const reason = entry.last_error ?? 'NOTIFICATION_NOT_SENT';
    return {
      orderId, status: 'failed', reason,
      category: (entry.last_category as FailureCategory | null) ?? reasonCategory(reason),
    };
  }
  return { orderId, status: 'failed', reason: 'DELIVERY_RECONCILIATION_REQUIRED', category: 'LEDGER_ERROR' };
}

export class PaidOrderWorkflow {
  private running = false;
  constructor(
    private readonly client: OrderClient,
    private readonly ledger: Ledger,
    private readonly provider: EmailProvider,
    private readonly adminEmail: string,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
  ) {}

  async run(): Promise<PaidOrderRunResult> {
    const runId = randomUUID();
    if (this.running) return { runId, status: 'busy', discovered: 0, eligible: 0, processed: 0, skipped: 0, failed: 0, results: [], adminNotifications: emptyAdminSummary };
    this.running = true;
    try {
      const orders = await this.client.getOrders();
      const notificationResults: AdminNotificationResult[] = [];
      const notify = async (notification: Parameters<AdminNotifier['notify']>[0]) => {
        try {
          notificationResults.push(await this.adminNotifications.notify(notification));
        } catch {
          notificationResults.push({ status: 'FAILED', reason: 'LEDGER_FAILURE' });
        }
      };
      for (const order of orders) {
        if (order.payment_status.toUpperCase() === 'VERIFICATION_FAILED') {
          await notify(paymentFailureNotification(order));
        }
      }
      const candidates = orders.filter(order => ['success', 'paid'].includes(order.payment_status.toLowerCase()));
      const results: PaidOrderResultItem[] = [];
      const runner = new NotificationRunner(this.ledger, this.provider.namespace);
      for (const candidate of candidates) {
        try {
          const order = validatePaidOrder(await this.client.getOrder(candidate.id), candidate.id);
          await notify(paidOrderNotification(order));
          const confirmed = validateConfirmation(order, candidate.id);
          const items = confirmed.items.map(i => `${i.title}${i.variant_title ? ` (${i.variant_title})` : ''}: ${i.quantity} x NGN ${i.price}`).join('\n');
          const message = { recipient: confirmed.customer_email!, subject: `Order #${confirmed.order_number} confirmation`,
            text: `${confirmed.customer_name ? `Hello ${confirmed.customer_name},\n` : ''}Order #${confirmed.order_number}\n${items}\nTotal: NGN ${confirmed.total}\nPayment status: ${confirmed.payment_status}` };
          const customer = await runner.run(confirmed.id, 'customer', key => this.provider.sendCustomerOrderConfirmation(message, key));
          if (customer.status === 'FAILED' || customer.status === 'PENDING') {
            results.push({ orderId: confirmed.id, status: 'failed', reason: customer.reason, category: customer.category }); continue;
          }
          const customerKey = `${this.provider.namespace}:paid-order-confirmation:${confirmed.id}:customer`;
          const customerFailure = exhaustedFailure(this.ledger, confirmed.id, customerKey);
          if (customerFailure) { results.push(customerFailure); continue; }
          const admin = await runner.run(confirmed.id, 'admin', key => this.provider.sendAdminOrderAlert({
            recipient: this.adminEmail, subject: `Paid order #${confirmed.order_number}`,
            text: `Order ID: ${confirmed.id}\nOrder #${confirmed.order_number}\n${items}\nTotal: NGN ${confirmed.total}\nPayment status: ${confirmed.payment_status}\nRun: ${runId}\nEvent: ${key}\nProcessed at: ${new Date().toISOString()}`,
          }, key));
          if (admin.status === 'FAILED' || admin.status === 'PENDING') {
            results.push({ orderId: confirmed.id, status: 'failed', reason: admin.reason, category: admin.category }); continue;
          }
          const adminKey = `${this.provider.namespace}:paid-order-confirmation:${confirmed.id}:admin`;
          const adminFailure = exhaustedFailure(this.ledger, confirmed.id, adminKey);
          if (adminFailure) { results.push(adminFailure); continue; }
          results.push({ orderId: confirmed.id, status: customer.status === 'SKIPPED' && admin.status === 'SKIPPED' ? 'skipped' : 'processed',
            simulated: this.provider.namespace === 'development-console' });
        } catch (error) {
          const reason = safeCode(error);
          if (['CUSTOMER_EMAIL_MISSING', 'VALIDATION_FAILED', 'ALVERON_API_FAILURE'].includes(reason)) {
            const key = `${this.provider.namespace}:paid-order-validation:${candidate.id}`;
            const claim = this.ledger.claim(key, candidate.id, 'paid-order-validation');
            if (claim) this.ledger.markFailure(claim, reason);
          }
          results.push({ orderId: candidate.id, status: 'failed', reason, category: reasonCategory(reason, classifyFailure(error)) });
        }
      }
      const count = (status: string) => results.filter(result => result.status === status).length;
      const statusCount = (status: AdminNotificationResult['status']) =>
        notificationResults.filter(result => result.status === status).length;
      const failureCategory = pickFailureCategory(results);
      return {
        runId, status: count('failed') ? 'partial_failure' : 'completed', discovered: orders.length,
        eligible: candidates.length, processed: count('processed'), skipped: count('skipped'), failed: count('failed'),
        ...(failureCategory ? { failureCategory } : {}),
        results,
        adminNotifications: {
          attempted: notificationResults.length - statusCount('DISABLED'),
          delivered: statusCount('SUCCESS'), skipped: statusCount('SKIPPED'), failed: statusCount('FAILED'),
          pending: statusCount('PENDING'), disabled: statusCount('DISABLED'),
        },
      };
    } finally { this.running = false; }
  }
}
