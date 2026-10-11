import { randomUUID } from 'node:crypto';
import type { OrderClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import { isPaid, type Order } from '../integrations/alveron/schemas.js';
import {
  disabledAdminNotifier,
  shippingSlaNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** The only Alveron endpoint this workflow reads. Admin-scoped, read-only. */
export const SHIPPING_SLA_ENDPOINT = '/orders';

/**
 * Statuses that still await shipment. `shipped` and later are excluded, as are terminal
 * cancelled/refunded orders — an order that will never ship is not a shipping delay.
 */
export const NOT_SHIPPED_STATUSES = ['paid', 'processing', 'packed', 'ready_for_shipment'] as const;

/**
 * Paid orders waiting past the SLA are reported at most once per (oldest order, waiting count)
 * via the shared notification ledger, so a persistent backlog does not re-alert every run while a
 * change in the backlog still does.
 *
 * READ-ONLY: this workflow never marks an order shipped. It only tells the admin that Alveron's
 * own state shows orders past the configured processing window.
 */
export interface ShippingSlaResult {
  runId: string;
  workflow: 'shipping-sla';
  status: 'completed' | 'failed' | 'busy';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ordersScanned: number;
  waiting: number;
  unknownAge: number;
  oldestAgeHours: number | null;
  notified: number;
  duplicates: number;
  code?: string;
  message: string;
}

export class ShippingSlaWorkflow {
  private running = false;
  constructor(
    private readonly client: OrderClient,
    private readonly slaHours: number,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(slaHours) || slaHours < 1 || slaHours > 24 * 365) {
      throw new Error('SHIPPING_SLA_HOURS_INVALID');
    }
  }

  async run(): Promise<ShippingSlaResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const base = {
      runId, workflow: 'shipping-sla' as const, endpoint: SHIPPING_SLA_ENDPOINT,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const finish = (over: { status: ShippingSlaResult['status']; message: string } &
      Omit<Partial<ShippingSlaResult>, 'status' | 'message'>): ShippingSlaResult => {
      const completedAtMs = this.now();
      return { ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), ordersScanned: 0, waiting: 0,
        unknownAge: 0, oldestAgeHours: null, notified: 0, duplicates: 0, ...over };
    };
    if (this.running) {
      return finish({ status: 'busy', code: 'BUSY', message: 'A shipping-SLA pass is already running.' });
    }
    this.running = true;
    try {
      const orders = await this.client.getOrders();
      const thresholdMs = this.slaHours * 60 * 60 * 1000;
      let waiting = 0;
      let unknownAge = 0;
      let oldest: { order: Order; ageMs: number } | null = null;

      for (const order of orders) {
        if (!isPaid(order.payment_status)) continue;
        if (!(NOT_SHIPPED_STATUSES as readonly string[]).includes(order.status.toLowerCase())) continue;
        const placedAt = order.payment_date ?? order.created_at;
        if (!placedAt) { unknownAge += 1; continue; }
        const ageMs = startedAtMs - Date.parse(placedAt);
        if (ageMs < thresholdMs) continue;
        waiting += 1;
        if (!oldest || ageMs > oldest.ageMs) oldest = { order, ageMs };
      }

      if (!oldest) {
        return finish({ status: 'completed', ordersScanned: orders.length, waiting, unknownAge,
          message: `No paid order is past the ${this.slaHours}h shipping window.` });
      }

      let status: AdminNotificationResult['status'];
      try {
        status = (await this.adminNotifications.notify(shippingSlaNotification({
          waitingCount: waiting, oldestOrderId: oldest.order.id, oldestOrderNumber: oldest.order.order_number,
          slaHours: this.slaHours,
        }))).status;
      } catch {
        status = 'FAILED';
      }
      const notified = status === 'SUCCESS' ? 1 : 0;
      const duplicates = status === 'SKIPPED' ? 1 : 0;
      return finish({ status: 'completed', ordersScanned: orders.length, waiting, unknownAge,
        oldestAgeHours: Math.floor(oldest.ageMs / (60 * 60 * 1000)), notified, duplicates,
        message: 'Shipping-SLA scan complete; automation never marks orders shipped.' });
    } catch (error) {
      return finish({ status: 'failed', code: safeCode(error),
        message: 'Orders could not be read; no shipping-SLA alert was sent.' });
    } finally { this.running = false; }
  }
}
