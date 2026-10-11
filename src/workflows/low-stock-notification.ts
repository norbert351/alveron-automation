import { randomUUID } from 'node:crypto';
import { MAX_CATALOG_PAGES, type CatalogClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import {
  disabledAdminNotifier,
  lowStockNotification,
  outOfStockNotification,
  restockNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** The only Alveron endpoint this workflow reads. Public catalog, read-only. */
export const CATALOG_ENDPOINT = '/products';

export const CATALOG_PAGE_SIZE = 50;

/** Ceiling on low-stock alerts per run, so a large catalogue cannot flood the admin chat. */
export const MAX_LOW_STOCK_ALERTS_PER_RUN = 20;
/** Ceiling on restock alerts per run. */
export const MAX_RESTOCK_ALERTS_PER_RUN = 20;

export interface LowStockOptions {
  now?: () => number;
  /**
   * Optional durable observation state. When present, the workflow remembers the last stock it
   * observed per variant and raises a restock alert only on the `previous <= 0 -> now > 0`
   * transition. No ledger means no restock detection (low/out-of-stock still work).
   */
  ledger?: Ledger;
}

export interface LowStockResult {
  runId: string;
  workflow: 'low-stock-notification';
  status: 'completed' | 'failed' | 'busy';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pagesRead: number;
  productsScanned: number;
  unparsableRows: number;
  belowThreshold: number;
  outOfStock: number;
  notified: number;
  duplicates: number;
  restocked: number;
  suppressedByCap: number;
  results: { variantId: string; status: 'notified' | 'duplicate' | 'restocked' | 'skipped' | 'failed'; reason?: string }[];
  code?: string;
  message: string;
}

/**
 * Detects variants at or below their product's low-stock threshold and alerts the admin.
 *
 * Detection uses Alveron's own `products.low_stock_alert` threshold against the `stock` the
 * catalog reports; no threshold is invented here and no stock is ever written. Products that do
 * not track inventory are skipped, because a stock level is not meaningful for them.
 *
 * Deduplication is per variant AND per observed stock level (enforced by the ledger key in
 * lowStockNotification), so a variant that stays below its threshold alerts once and then stays
 * quiet, while a further drop to a new level alerts again.
 */
export class LowStockNotificationWorkflow {
  private running = false;
  private readonly now: () => number;
  private readonly ledger?: Ledger;
  constructor(
    private readonly client: CatalogClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    options: LowStockOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger;
  }

  async run(): Promise<LowStockResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const base = {
      runId, workflow: 'low-stock-notification' as const, endpoint: CATALOG_ENDPOINT,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const finish = (over: { status: LowStockResult['status']; message: string } &
      Omit<Partial<LowStockResult>, 'status' | 'message'>): LowStockResult => {
      const completedAtMs = this.now();
      return { ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), pagesRead: 0, productsScanned: 0,
        unparsableRows: 0, belowThreshold: 0, outOfStock: 0, notified: 0, duplicates: 0,
        restocked: 0, suppressedByCap: 0, results: [], ...over };
    };
    if (this.running) {
      return finish({ status: 'busy', code: 'BUSY', message: 'A low-stock scan is already running.' });
    }
    this.running = true;
    try {
      const results: LowStockResult['results'] = [];
      const seen = new Set<string>();
      let pagesRead = 0;
      let productsScanned = 0;
      let unparsableRows = 0;
      let belowThreshold = 0;
      let outOfStock = 0;
      let notified = 0;
      let duplicates = 0;
      let restocked = 0;
      let suppressedByCap = 0;
      let total = 0;
      const notify = async (
        notification: Parameters<AdminNotifier['notify']>[0],
      ): Promise<AdminNotificationResult['status']> => {
        try { return (await this.adminNotifications.notify(notification)).status; }
        catch { return 'FAILED'; }
      };

      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const offset = page * CATALOG_PAGE_SIZE;
        const response = await this.client.getProductCatalog(CATALOG_PAGE_SIZE, offset);
        pagesRead = page + 1;
        total = response.total;
        productsScanned += response.products.length;
        unparsableRows += response.skipped;
        for (const product of response.products) {
          // No threshold or no inventory tracking means neither low stock nor a restock is defined.
          if (!product.trackInventory || product.lowStockAlert === null) continue;
          for (const variant of product.variants) {
            if (variant.stock === null || seen.has(variant.id)) continue;
            seen.add(variant.id);
            const variantTitle = variantLabel(variant.color, variant.size);
            // Restock transition: the last level we observed was zero and it is now positive.
            if (this.ledger) {
              const previous = this.ledger.getState(`inventory-level:${variant.id}`);
              const previousStock = previous === null ? null : Number(previous);
              if (previousStock !== null && Number.isSafeInteger(previousStock) &&
                  previousStock <= 0 && variant.stock > 0) {
                if (restocked >= MAX_RESTOCK_ALERTS_PER_RUN) suppressedByCap += 1;
                else {
                  const status = await notify(
                    restockNotification({ variantId: variant.id, productTitle: product.title, variantTitle, stock: variant.stock }));
                  if (status === 'SUCCESS') { restocked += 1; results.push({ variantId: variant.id, status: 'restocked' }); }
                  else if (status === 'SKIPPED') { duplicates += 1; results.push({ variantId: variant.id, status: 'duplicate' }); }
                  else if (status === 'DISABLED') {
                    results.push({ variantId: variant.id, status: 'skipped', reason: 'ADMIN_CHANNEL_DISABLED' });
                  } else results.push({ variantId: variant.id, status: 'failed', reason: status });
                }
              }
              this.ledger.setState(`inventory-level:${variant.id}`, String(variant.stock));
            }
            if (variant.stock > product.lowStockAlert) continue;
            belowThreshold += 1;
            if (variant.stock === 0) outOfStock += 1;
            if (notified >= MAX_LOW_STOCK_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
            // Zero stock is a distinct OUT OF STOCK alert; a positive-but-low level is LOW STOCK.
            // The two use different ledger keys, so the transition 2 -> 0 alerts as a new event.
            const status = await notify(variant.stock === 0
              ? outOfStockNotification({ variantId: variant.id, productTitle: product.title, variantTitle })
              : lowStockNotification({
                variantId: variant.id, productTitle: product.title, variantTitle,
                stock: variant.stock, lowStockAlert: product.lowStockAlert,
              }));
            if (status === 'SUCCESS') { notified += 1; results.push({ variantId: variant.id, status: 'notified' }); }
            else if (status === 'SKIPPED') { duplicates += 1; results.push({ variantId: variant.id, status: 'duplicate' }); }
            else if (status === 'DISABLED') {
              // Not a failure: no admin channel is configured, so nothing was attempted.
              results.push({ variantId: variant.id, status: 'skipped', reason: 'ADMIN_CHANNEL_DISABLED' });
            } else results.push({ variantId: variant.id, status: 'failed', reason: status });
          }
        }
        // Stop on a short page, or once everything the catalog reports has been read.
        if (response.products.length + response.skipped < CATALOG_PAGE_SIZE) break;
        if (offset + CATALOG_PAGE_SIZE >= total) break;
      }
      return finish({ status: 'completed', pagesRead, productsScanned, unparsableRows, belowThreshold,
        outOfStock, notified, duplicates, restocked, suppressedByCap, results,
        message: 'Catalog scanned read-only; low-stock and restock alerts are deduplicated per variant and level.' });
    } catch (error) {
      return finish({ status: 'failed', code: safeCode(error),
        message: 'Catalog could not be read; no low-stock alert was sent.' });
    } finally { this.running = false; }
  }
}

/** Builds a readable variant label from the catalog's own color/size values only. */
function variantLabel(color: string | null, size: string | null): string | null {
  const parts = [color, size].map(part => (typeof part === 'string' ? part.trim() : '')).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}
