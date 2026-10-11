import { randomUUID } from 'node:crypto';
import type { ProductCatalogPage } from '../integrations/alveron/catalog.js';
import type { ProductRequestPage } from '../integrations/alveron/product-requests.js';
import { MAX_CATALOG_PAGES, MAX_PRODUCT_REQUEST_PAGES } from '../integrations/alveron/client.js';
import type { Order } from '../integrations/alveron/schemas.js';
import { classifyFailure, safeCode, type FailureCategory } from '../integrations/alveron/errors.js';
import {
  dailyOperationsNotification,
  disabledAdminNotifier,
  financeBusinessDate,
  systemHealthNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** Composes only the read-only sources this summary needs. AlveronClient already implements all three. */
export interface OperationsSummaryClient {
  getOrders(): Promise<Order[]>;
  getProductCatalog(limit: number, offset: number): Promise<ProductCatalogPage>;
  getProductRequests(page: number, pageSize: number): Promise<ProductRequestPage>;
}

export const SUMMARY_CATALOG_PAGE_SIZE = 50;
export const SUMMARY_REQUEST_PAGE_SIZE = 25;
const requestStatuses = { newRequest: ['pending'], awaitingQuote: ['searching', 'found'] };

export interface DailyOperationsResult {
  runId: string;
  workflow: 'daily-operations-summary';
  status: 'completed' | 'failed' | 'busy';
  businessDate: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  counts: {
    paidOrders: number;
    pendingOrders: number;
    cancelledOrders: number;
    processing: number;
    shipped: number;
    awaitingPickup: number;
    lowStock: number;
    outOfStock: number;
    newRequests: number;
    awaitingQuote: number;
  };
  alveronHealthy: boolean;
  notificationStatus: AdminNotificationResult['status'];
  code?: string;
  failureCategory?: FailureCategory;
  message: string;
}

/**
 * ALV - Daily Operations Summary.
 *
 * A once-per-business-day operational digest for the owner/admin, sent through the existing admin
 * channel. It deliberately excludes finance figures (those belong to the finance workflows) and
 * computes every count from the same authoritative read endpoints the monitoring workflows use. It
 * never mutates Alveron. Idempotency is the ledger keyed on the business date, so a restart or a
 * duplicate schedule cannot send the same day's summary twice.
 *
 * If any source fails, the summary is still sent with `alveronHealthy: false` and the failing
 * counts left at zero rather than guessed — an incomplete summary is better than a silent one.
 */
export class DailyOperationsSummaryWorkflow {
  private running = false;
  constructor(
    private readonly client: OperationsSummaryClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly timeZone = 'Africa/Lagos',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<DailyOperationsResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const businessDate = financeBusinessDate(new Date(startedAtMs).toISOString(), this.timeZone);
    const base = { runId, workflow: 'daily-operations-summary' as const, businessDate,
      startedAt: new Date(startedAtMs).toISOString() };
    const finish = (over: { status: DailyOperationsResult['status']; message: string } &
      Partial<Omit<DailyOperationsResult, 'status' | 'message'>>): DailyOperationsResult => {
      const completedAtMs = this.now();
      return {
        ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        counts: { paidOrders: 0, pendingOrders: 0, cancelledOrders: 0, processing: 0, shipped: 0,
          awaitingPickup: 0, lowStock: 0, outOfStock: 0, newRequests: 0, awaitingQuote: 0 },
        alveronHealthy: true, notificationStatus: 'DISABLED', ...over,
      };
    };
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A daily summary run is already in progress.' });
    this.running = true;
    try {
      const counts = {
        paidOrders: 0, pendingOrders: 0, cancelledOrders: 0, processing: 0, shipped: 0,
        awaitingPickup: 0, lowStock: 0, outOfStock: 0, newRequests: 0, awaitingQuote: 0,
      };
      let alveronHealthy = true;

      try {
        for (const order of await this.client.getOrders()) countOrder(order, counts);
      } catch { alveronHealthy = false; }

      try {
        const seen = new Set<string>();
        for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
          const offset = page * SUMMARY_CATALOG_PAGE_SIZE;
          const response = await this.client.getProductCatalog(SUMMARY_CATALOG_PAGE_SIZE, offset);
          for (const product of response.products) {
            if (!product.trackInventory || product.lowStockAlert === null) continue;
            for (const variant of product.variants) {
              if (variant.stock === null || seen.has(variant.id)) continue;
              seen.add(variant.id);
              if (variant.stock === 0) counts.outOfStock += 1;
              else if (variant.stock <= product.lowStockAlert) counts.lowStock += 1;
            }
          }
          if (response.products.length + response.skipped < SUMMARY_CATALOG_PAGE_SIZE) break;
          if (offset + SUMMARY_CATALOG_PAGE_SIZE >= response.total) break;
        }
      } catch { alveronHealthy = false; }

      try {
        for (let page = 1; page <= MAX_PRODUCT_REQUEST_PAGES; page++) {
          const response = await this.client.getProductRequests(page, SUMMARY_REQUEST_PAGE_SIZE);
          for (const request of response.requests) {
            const status = request.status?.toLowerCase();
            if (status && requestStatuses.newRequest.includes(status)) counts.newRequests += 1;
            else if (status && requestStatuses.awaitingQuote.includes(status)) counts.awaitingQuote += 1;
          }
          if (response.requests.length < SUMMARY_REQUEST_PAGE_SIZE) break;
        }
      } catch { alveronHealthy = false; }

      let notificationStatus: AdminNotificationResult['status'];
      try {
        notificationStatus = (await this.adminNotifications.notify(dailyOperationsNotification({
          ...counts, alveronHealthy, businessDate,
        }))).status;
      } catch { notificationStatus = 'FAILED'; }

      return finish({ status: 'completed', counts, alveronHealthy, notificationStatus,
        message: `Daily operations summary for ${businessDate} prepared${alveronHealthy ? '' : ' (one or more Alveron reads failed)'}.` });
    } catch (error) {
      const notificationStatus = await safeNotifyHealth(this.adminNotifications);
      return finish({ status: 'failed', code: safeCode(error), failureCategory: classifyFailure(error),
        alveronHealthy: false, notificationStatus,
        message: 'Daily operations summary could not be completed.' });
    } finally { this.running = false; }
  }
}

function countOrder(order: Order, counts: DailyOperationsResult['counts']): void {
  const status = order.status.toLowerCase();
  const payment = order.payment_status.toLowerCase();
  if (payment === 'success' || payment === 'paid') counts.paidOrders += 1;
  if (status === 'pending') counts.pendingOrders += 1;
  if (status === 'cancelled') counts.cancelledOrders += 1;
  if (status === 'processing') counts.processing += 1;
  if (status === 'shipped' || status === 'in_transit') counts.shipped += 1;
  if (status === 'ready_for_pickup') counts.awaitingPickup += 1;
}

async function safeNotifyHealth(notifications: AdminNotifier): Promise<AdminNotificationResult['status']> {
  try {
    return (await notifications.notify(systemHealthNotification({
      environment: 'automation', components: [{ name: 'Daily summary', ok: false }],
    }))).status;
  } catch { return 'FAILED'; }
}
