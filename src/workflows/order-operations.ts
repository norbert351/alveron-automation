import { randomUUID } from 'node:crypto';
import type { OrderClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import type { Order } from '../integrations/alveron/schemas.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import type { EmailProvider } from '../providers/email/index.js';
import { orderStatusEmail } from '../providers/email/order-emails.js';
import {
  disabledAdminNotifier,
  orderStatusNotification,
  type AdminNotifier,
} from '../providers/admin/index.js';
import { NotificationRunner } from './notification-runner.js';

/** The only Alveron endpoint this workflow reads. Admin-scoped, read-only. */
export const ORDER_OPERATIONS_ENDPOINT = '/orders';

/**
 * Statuses worth an operational alert. `paid` is deliberately excluded: the paid-order workflow
 * already owns it, and duplicating it here would produce two alerts for one business event.
 */
export const OPERATIONAL_STATUSES = [
  'processing', 'packed', 'ready_for_shipment', 'shipped', 'in_transit',
  'ready_for_pickup', 'picked_up', 'delivered', 'cancelled', 'refunded', 'refund_completed',
] as const;

/** Ceiling on order-status alerts per run so a large backfill cannot flood the admin chat. */
export const MAX_ORDER_STATUS_ALERTS_PER_RUN = 25;
/** Ceiling on customer lifecycle emails per run, for the same reason. */
export const MAX_ORDER_STATUS_EMAILS_PER_RUN = 25;

export interface OrderOperationsOptions {
  now?: () => number;
  /**
   * Optional customer email channel. When present with the ledger, the workflow also sends the
   * customer-facing lifecycle email for the observed status (idempotent per order + status). The
   * mode-aware provider owns the live/test/disabled safety gate, so this workflow never chooses.
   */
  emailProvider?: EmailProvider;
  ledger?: Ledger;
}

export interface OrderOperationsResult {
  runId: string;
  workflow: 'order-operations';
  status: 'completed' | 'failed' | 'busy';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  discovered: number;
  eligible: number;
  notified: number;
  duplicates: number;
  suppressedByCap: number;
  customerEmails: number;
  customerEmailDuplicates: number;
  customerEmailFailures: number;
  results: { orderId: string; status: string; notificationStatus: string; customerEmailStatus?: string; reason?: string }[];
  code?: string;
  message: string;
}

/**
 * Operational, read-only order notifications.
 *
 * Alveron remains the source of truth for order state. This workflow never calls
 * `PATCH /orders/:id/status` or `/fulfilment`; it observes the status Alveron reports and tells the
 * admin about it, and (when configured) sends the matching customer lifecycle email. Idempotency is
 * the shared notification ledger keyed `order-status:<orderId>:<status>` for the admin alert and
 * `order-status-email:<status>:<orderId>:customer` for the customer email, so a retried or
 * overlapping poll cannot produce a second message for the same transition, while a later
 * transition to a new status still notifies.
 *
 * Note: `GET /orders` exposes only the CURRENT status, so this is a "first observed" model, not a
 * journal of every transition. That is stated plainly rather than inferred from unavailable data.
 */
export class OrderOperationsWorkflow {
  private running = false;
  private readonly now: () => number;
  private readonly emailProvider?: EmailProvider;
  private readonly ledger?: Ledger;
  constructor(
    private readonly client: OrderClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    options: OrderOperationsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.emailProvider = options.emailProvider;
    this.ledger = options.ledger;
  }

  async run(): Promise<OrderOperationsResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const base = {
      runId, workflow: 'order-operations' as const, endpoint: ORDER_OPERATIONS_ENDPOINT,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const finish = (over: { status: OrderOperationsResult['status']; message: string } &
      Omit<Partial<OrderOperationsResult>, 'status' | 'message'>): OrderOperationsResult => {
      const completedAtMs = this.now();
      return { ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), discovered: 0, eligible: 0,
        notified: 0, duplicates: 0, suppressedByCap: 0, customerEmails: 0,
        customerEmailDuplicates: 0, customerEmailFailures: 0, results: [], ...over };
    };
    if (this.running) {
      return finish({ status: 'busy', code: 'BUSY', message: 'An order-operations poll is already running.' });
    }
    this.running = true;
    try {
      const orders = await this.client.getOrders();
      const results: OrderOperationsResult['results'] = [];
      const seen = new Set<string>();
      let eligible = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;
      let customerEmails = 0;
      let customerEmailDuplicates = 0;
      let customerEmailFailures = 0;
      const emailProvider = this.emailProvider;
      const ledger = this.ledger;
      const runner = emailProvider && ledger
        ? new NotificationRunner(ledger, emailProvider.namespace)
        : null;

      for (const order of orders) {
        if (!isOperational(order)) continue;
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        eligible += 1;
        const entry: OrderOperationsResult['results'][number] = {
          orderId: order.id, status: order.status, notificationStatus: 'SKIPPED',
        };
        if (notified >= MAX_ORDER_STATUS_ALERTS_PER_RUN) { suppressedByCap += 1; }
        else {
          try {
            entry.notificationStatus = (await this.adminNotifications.notify(orderStatusNotification({
              orderId: order.id, orderNumber: order.order_number, status: order.status,
            }))).status;
          } catch {
            entry.notificationStatus = 'FAILED';
          }
          if (entry.notificationStatus === 'SUCCESS') notified += 1;
          else if (entry.notificationStatus === 'SKIPPED') duplicates += 1;
        }
        // Customer lifecycle email (only for statuses with a defined template and a real address).
        const customerEmail = runner && emailProvider && order.customer_email ? orderStatusEmail(order) : null;
        if (runner && emailProvider && customerEmail) {
          if (customerEmails >= MAX_ORDER_STATUS_EMAILS_PER_RUN) {
            entry.customerEmailStatus = 'SUPPRESSED_BY_CAP';
          } else {
            try {
              const result = await runner.run(order.id, 'customer',
                key => emailProvider.sendCustomerTransactional(customerEmail, key),
                `order-status-email:${order.status.toLowerCase()}`);
              entry.customerEmailStatus = result.status;
              if (result.status === 'SUCCESS') customerEmails += 1;
              else if (result.status === 'SKIPPED') customerEmailDuplicates += 1;
              else {
                customerEmailFailures += 1;
                entry.reason = result.status === 'FAILED' || result.status === 'PENDING' ? result.reason : undefined;
              }
            } catch {
              customerEmailFailures += 1;
              entry.customerEmailStatus = 'FAILED';
            }
          }
        }
        results.push(entry);
      }
      return finish({ status: 'completed', discovered: orders.length, eligible, notified, duplicates,
        suppressedByCap, customerEmails, customerEmailDuplicates, customerEmailFailures, results,
        message: `Orders read read-only; ${notified} status alert(s) sent, ${duplicates} already notified, ${customerEmails} customer email(s) sent.` });
    } catch (error) {
      return finish({ status: 'failed', code: safeCode(error),
        message: 'Orders could not be read; no order-status alert was sent.' });
    } finally { this.running = false; }
  }
}

function isOperational(order: Order): boolean {
  return (OPERATIONAL_STATUSES as readonly string[]).includes(order.status.toLowerCase());
}
