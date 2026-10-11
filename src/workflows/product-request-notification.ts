import { randomUUID } from 'node:crypto';
import { MAX_PRODUCT_REQUEST_PAGES, type ProductRequestClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import {
  disabledAdminNotifier,
  productRequestNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** The only Alveron endpoint this workflow reads. Admin-scoped, read-only. */
export const PRODUCT_REQUEST_ENDPOINT = '/admin/product-requests';

export const PRODUCT_REQUEST_PAGE_SIZE = 25;

/**
 * Ceiling on admin alerts per run. A burst of new requests is reported as a count rather than
 * an unbounded Telegram flood; remaining requests stay unclaimed and alert on the next run.
 */
export const MAX_ALERTS_PER_RUN = 25;

export interface ProductRequestResult {
  runId: string;
  workflow: 'product-request-notification';
  status: 'completed' | 'failed' | 'busy';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pagesRead: number;
  discovered: number;
  unparsableRows: number;
  notified: number;
  duplicates: number;
  suppressedByCap: number;
  results: { requestId: string; status: 'notified' | 'duplicate' | 'skipped' | 'failed'; reason?: string }[];
  code?: string;
  message: string;
}

/**
 * Detects newly submitted product-sourcing requests and alerts the admin.
 *
 * Alveron remains the source of truth: this workflow only reads. Idempotency is delegated
 * entirely to AdminNotificationService, which claims the request identity in the existing
 * notification ledger — so a retried or overlapping poll can never produce a duplicate alert,
 * and this workflow never has to reconstruct a ledger key.
 *
 * Sort order of the endpoint is not assumed: every request on a read page is offered to the
 * notifier and the ledger decides. Paging stops early only when a page yields nothing new,
 * which keeps the steady-state cost at one request without ever skipping a request that a full
 * read would have returned (worst case, a new request alerts on the following poll).
 */
export class ProductRequestNotificationWorkflow {
  private running = false;
  constructor(
    private readonly client: ProductRequestClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<ProductRequestResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const base = {
      runId, workflow: 'product-request-notification' as const, endpoint: PRODUCT_REQUEST_ENDPOINT,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const finish = (over: { status: ProductRequestResult['status']; message: string } &
      Omit<Partial<ProductRequestResult>, 'status' | 'message'>): ProductRequestResult => {
      const completedAtMs = this.now();
      return { ...base, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), pagesRead: 0, discovered: 0,
        unparsableRows: 0, notified: 0, duplicates: 0, suppressedByCap: 0, results: [], ...over };
    };
    if (this.running) {
      return finish({ status: 'busy', code: 'BUSY', message: 'A product-request poll is already running.' });
    }
    this.running = true;
    try {
      const results: ProductRequestResult['results'] = [];
      const seen = new Set<string>();
      let pagesRead = 0;
      let discovered = 0;
      let unparsableRows = 0;
      let notified = 0;
      let duplicates = 0;
      let suppressedByCap = 0;

      for (let page = 1; page <= MAX_PRODUCT_REQUEST_PAGES; page++) {
        const response = await this.client.getProductRequests(page, PRODUCT_REQUEST_PAGE_SIZE);
        pagesRead = page;
        discovered += response.requests.length;
        unparsableRows += response.skipped;
        let newThisPage = 0;
        for (const request of response.requests) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          if (notified >= MAX_ALERTS_PER_RUN) { suppressedByCap += 1; continue; }
          let status: AdminNotificationResult['status'];
          try {
            status = (await this.adminNotifications.notify(productRequestNotification(request))).status;
          } catch {
            status = 'FAILED';
          }
          if (status === 'SUCCESS') {
            notified += 1; newThisPage += 1;
            results.push({ requestId: request.id, status: 'notified' });
          } else if (status === 'SKIPPED') {
            duplicates += 1;
            results.push({ requestId: request.id, status: 'duplicate' });
          } else if (status === 'DISABLED') {
            // Not a failure: no admin channel is configured, so nothing was attempted.
            results.push({ requestId: request.id, status: 'skipped', reason: 'ADMIN_CHANNEL_DISABLED' });
          } else {
            results.push({ requestId: request.id, status: 'failed', reason: status });
          }
        }
        if (response.requests.length < PRODUCT_REQUEST_PAGE_SIZE) break;
        if (!newThisPage) break;
      }
      return finish({ status: 'completed', pagesRead, discovered, unparsableRows, notified, duplicates,
        suppressedByCap, results,
        message: 'Product-sourcing requests read from Alveron; admin alerts are deduplicated by request identity.' });
    } catch (error) {
      return finish({ status: 'failed', code: safeCode(error),
        message: 'Product-sourcing requests could not be read; no alert was sent.' });
    } finally { this.running = false; }
  }
}
