import { AuthManager } from './auth.js';
import { HttpTransport } from './http.js';
import { AppError } from './errors.js';
import { isId, parseOrder, parseOrders, parseReferralStats, type Order, type ReferralStats } from './schemas.js';
import { parseProductCatalog, type ProductCatalogPage } from './catalog.js';
import {
  AUTOMATION_EVENTS_PATH, parseAutomationEventAck, parseAutomationEventPage,
  type AutomationEventPage,
} from './automation-events.js';
import { parseProductRequestPage, type ProductRequestPage } from './product-requests.js';
import {
  FINANCE_ENDPOINTS, FINANCE_EVENTS_PATH,
  parseFinanceDailyReport, parseFinanceEventAck, parseFinanceEventPage, parseFinanceExpensePage,
  parseFinanceNativeOverview, parseFinancePayablePage, parseFinanceReconciliation, parseFinanceReviewQueue,
  parseFinanceWeeklyReport, parseFinanceWithdrawalPage,
  type FinanceDailyReport, type FinanceEventPage, type FinanceExpensePage, type FinanceNativeOverview,
  type FinancePayablePage, type FinanceReconciliation, type FinanceReviewQueue, type FinanceWeeklyReport,
  type FinanceWithdrawalPage,
} from './finance.js';
export interface OrderClient { getOrders(): Promise<Order[]>; getOrder(id: string): Promise<Order>; }
export interface ReferralClient { triggerReferralProcessing(): Promise<ReferralStats>; }
export interface CatalogClient { getProductCatalog(limit: number, offset: number): Promise<ProductCatalogPage>; }
export interface ProductRequestClient { getProductRequests(page: number, pageSize: number): Promise<ProductRequestPage>; }
/**
 * Read-only finance surface. Every method consumes an Alveron-authoritative endpoint; no method
 * computes a financial total and no method writes. `FINANCE_ENDPOINT_UNAVAILABLE` (HTTP 404) is
 * surfaced explicitly so the workflows can alert that the contract is not yet served.
 */
export interface FinanceClient {
  getFinanceOverview(): Promise<FinanceNativeOverview>;
  getFinanceDailyReport(): Promise<FinanceDailyReport>;
  getFinanceWeeklyReport(): Promise<FinanceWeeklyReport>;
  getFinanceReconciliation(): Promise<FinanceReconciliation>;
  getPendingReviewExpenses(): Promise<FinanceExpensePage>;
  getSupplierPayables(): Promise<FinancePayablePage>;
  getFinanceReviewQueue(): Promise<FinanceReviewQueue>;
  getOwnerWithdrawals(): Promise<FinanceWithdrawalPage>;
}

/**
 * Read + acknowledge the Alveron finance outbox. The list is read-only; acknowledgement is the
 * single non-financial write permitted (it marks one outbox event delivered). No method here
 * computes or mutates a financial figure.
 */
export interface FinanceEventClient {
  listFinanceEvents(status?: 'pending' | 'delivered', page?: number, pageSize?: number): Promise<FinanceEventPage>;
  ackFinanceEvent(id: string): Promise<{ id: string; status: 'delivered' }>;
}

/**
 * Read + acknowledge the Alveron automation outbox. Same contract shape as `FinanceEventClient`:
 * read-only listing plus one non-financial acknowledgement that only flips an outbox row to
 * `delivered`. No method mutates an order, payment or customer.
 */
export interface AutomationEventClient {
  listAutomationEvents(status?: 'pending' | 'delivered', page?: number, pageSize?: number): Promise<AutomationEventPage>;
  ackAutomationEvent(id: string): Promise<{ id: string; status: 'delivered' }>;
}

const outboxEventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { FINANCE_ENDPOINTS, FINANCE_EVENTS_PATH } from './finance.js';
export { AUTOMATION_EVENTS_PATH } from './automation-events.js';

/** Hard ceilings so a pagination bug can never turn into an unbounded request loop. */
export const MAX_CATALOG_PAGES = 20;
export const MAX_PRODUCT_REQUEST_PAGES = 10;
/** Order-scan defaults. Alveron accepts `limit` 1..1000 and `offset` 0..100000; these stay well inside it. */
export const ORDER_PAGE_SIZE = 100;
export const MAX_ORDER_PAGES = 20;

export class AlveronClient implements OrderClient, ReferralClient, CatalogClient, ProductRequestClient, FinanceClient, FinanceEventClient, AutomationEventClient {
  constructor(
    private readonly http: HttpTransport,
    private readonly auth: AuthManager,
    private readonly orderPageSize: number = ORDER_PAGE_SIZE,
    private readonly maxOrderPages: number = MAX_ORDER_PAGES,
  ) {}
  private async read(path: string): Promise<unknown> {
    let session = await this.auth.getSession();
    try { return await this.http.request('GET', path, session.token); }
    catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 401) throw error;
      session = await this.auth.getSession(session);
      return this.http.request('GET', path, session.token);
    }
  }
  /**
   * Finance reads reuse the authenticated transport. A 404 is retagged as
   * `FINANCE_ENDPOINT_UNAVAILABLE` so a not-yet-implemented Alveron contract is reported honestly
   * instead of surfacing as a generic API failure.
   */
  private async financeRead(path: string): Promise<unknown> {
    try { return await this.read(path); }
    catch (error) {
      if (error instanceof AppError && error.httpStatus === 404) throw new AppError('FINANCE_ENDPOINT_UNAVAILABLE', 404);
      throw error;
    }
  }
  /**
   * Reads the admin order list through Alveron's explicit `limit`/`offset` pagination instead of
   * a single unbounded `GET /orders`. Bounded by `maxOrderPages`, deduplicated by order id so an
   * order cannot be processed twice across pages, and stopped early on the first short/empty page.
   * The response is a plain array (no pagination metadata), so a malformed page is rejected by
   * `parseOrders` rather than silently treated as "no orders".
   */
  async getOrders(): Promise<Order[]> {
    if (!Number.isInteger(this.orderPageSize) || this.orderPageSize < 1 || this.orderPageSize > 1000 ||
        !Number.isInteger(this.maxOrderPages) || this.maxOrderPages < 1 || this.maxOrderPages > 100) {
      throw new AppError('VALIDATION_FAILED');
    }
    const orders: Order[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < this.maxOrderPages; page++) {
      const offset = page * this.orderPageSize;
      const batch = parseOrders(await this.read(`/orders?limit=${this.orderPageSize}&offset=${offset}`));
      for (const order of batch) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        orders.push(order);
      }
      if (batch.length < this.orderPageSize) break;
    }
    return orders;
  }
  async getOrder(id: string): Promise<Order> {
    if (!isId(id)) throw new AppError('VALIDATION_FAILED');
    return parseOrder(await this.read(`/orders/${id}`));
  }
  /**
   * Triggers Alveron's OWN referral processing. GET /referrals/admin/stats awaits
   * processPendingReferrals() before responding (verified in Alveron source), and that method
   * processes ALL pending referrals globally. No referral rules are implemented here.
   * NOTE: Alveron wraps the call in .catch(() => undefined), so a 200 response proves the
   * endpoint executed but NOT that processing succeeded, and reports no processed count.
   */
  async triggerReferralProcessing(): Promise<ReferralStats> {
    return parseReferralStats(await this.read('/referrals/admin/stats'));
  }

  /** Read-only catalog page used for low-stock detection. Never writes. */
  async getProductCatalog(limit: number, offset: number): Promise<ProductCatalogPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new AppError('VALIDATION_FAILED');
    return parseProductCatalog(await this.read(`/products?limit=${limit}&offset=${offset}`));
  }

  /** Read-only product-sourcing request page. Never writes. */
  async getProductRequests(page: number, pageSize: number): Promise<ProductRequestPage> {
    if (!Number.isInteger(page) || page < 1 || page > 1000 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AppError('VALIDATION_FAILED');
    return parseProductRequestPage(await this.read(`/admin/product-requests?page=${page}&pageSize=${pageSize}`));
  }

  async getFinanceOverview(): Promise<FinanceNativeOverview> {
    return parseFinanceNativeOverview(await this.financeRead(FINANCE_ENDPOINTS.overview));
  }
  async getFinanceDailyReport(): Promise<FinanceDailyReport> {
    return parseFinanceDailyReport(await this.financeRead(FINANCE_ENDPOINTS.dailyReport));
  }
  async getFinanceWeeklyReport(): Promise<FinanceWeeklyReport> {
    return parseFinanceWeeklyReport(await this.financeRead(FINANCE_ENDPOINTS.weeklyReport));
  }
  async getFinanceReconciliation(): Promise<FinanceReconciliation> {
    return parseFinanceReconciliation(await this.financeRead(FINANCE_ENDPOINTS.reconciliation));
  }
  async getPendingReviewExpenses(): Promise<FinanceExpensePage> {
    return parseFinanceExpensePage(await this.financeRead(FINANCE_ENDPOINTS.pendingReviewExpenses));
  }
  async getSupplierPayables(): Promise<FinancePayablePage> {
    return parseFinancePayablePage(await this.financeRead(FINANCE_ENDPOINTS.supplierPayables));
  }
  async getFinanceReviewQueue(): Promise<FinanceReviewQueue> {
    return parseFinanceReviewQueue(await this.financeRead(FINANCE_ENDPOINTS.reviewQueue));
  }
  async getOwnerWithdrawals(): Promise<FinanceWithdrawalPage> {
    return parseFinanceWithdrawalPage(await this.financeRead(FINANCE_ENDPOINTS.withdrawals));
  }

  /**
   * Reads the outbox. The bounded pagination is validated here and again by the transport
   * allowlist, so only `status=pending|delivered`, `page`, `pageSize` can ever be sent.
   */
  async listFinanceEvents(status: 'pending' | 'delivered' = 'pending', page = 1, pageSize = 50): Promise<FinanceEventPage> {
    if ((status !== 'pending' && status !== 'delivered') ||
        !Number.isInteger(page) || page < 1 || page > 10000 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new AppError('VALIDATION_FAILED');
    }
    return parseFinanceEventPage(await this.financeRead(
      `${FINANCE_EVENTS_PATH}?status=${status}&page=${page}&pageSize=${pageSize}`,
    ));
  }

  /**
   * Acknowledges one outbox event (idempotent). Reuses the authenticated transport and the
   * existing single re-auth on a 401. Never acknowledges a financial record — only the outbox row.
   */
  async ackFinanceEvent(id: string): Promise<{ id: string; status: 'delivered' }> {
    if (!outboxEventIdPattern.test(id)) throw new AppError('VALIDATION_FAILED');
    const path = `${FINANCE_EVENTS_PATH}/${id}/ack`;
    let session = await this.auth.getSession();
    try {
      return parseFinanceEventAck(await this.http.request('POST', path, session.token));
    } catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 401) throw error;
      session = await this.auth.getSession(session);
      return parseFinanceEventAck(await this.http.request('POST', path, session.token));
    }
  }

  /** Reads the automation outbox. Bounded pagination is validated here and by the transport allowlist. */
  async listAutomationEvents(status: 'pending' | 'delivered' = 'pending', page = 1, pageSize = 50): Promise<AutomationEventPage> {
    if ((status !== 'pending' && status !== 'delivered') ||
        !Number.isInteger(page) || page < 1 || page > 10000 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new AppError('VALIDATION_FAILED');
    }
    return parseAutomationEventPage(await this.read(
      `${AUTOMATION_EVENTS_PATH}?status=${status}&page=${page}&pageSize=${pageSize}`,
    ));
  }

  /** Acknowledges one automation event (idempotent). Only flips the outbox row to `delivered`. */
  async ackAutomationEvent(id: string): Promise<{ id: string; status: 'delivered' }> {
    if (!outboxEventIdPattern.test(id)) throw new AppError('VALIDATION_FAILED');
    const path = `${AUTOMATION_EVENTS_PATH}/${id}/ack`;
    let session = await this.auth.getSession();
    try {
      return parseAutomationEventAck(await this.http.request('POST', path, session.token));
    } catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 401) throw error;
      session = await this.auth.getSession(session);
      return parseAutomationEventAck(await this.http.request('POST', path, session.token));
    }
  }
}
