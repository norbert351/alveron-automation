import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { classifyFailure, safeCode } from '../integrations/alveron/errors.js';

export interface GatewayRoute {
  readonly bodyMode?: 'empty' | 'automation-error';
  run(input?: unknown): Promise<{ status: string }>;
}
export interface GatewayRoutes {
  paidOrder: GatewayRoute;
  referral: GatewayRoute;
  adminNotification?: GatewayRoute;
  productRequests?: GatewayRoute;
  lowStock?: GatewayRoute;
  orderOperations?: GatewayRoute;
  reconciliation?: GatewayRoute;
  shippingSla?: GatewayRoute;
  systemHealth?: GatewayRoute;
  financeDailyReport?: GatewayRoute;
  financeWeeklyReport?: GatewayRoute;
  financeReconciliation?: GatewayRoute;
  financeExpenseReview?: GatewayRoute;
  financeSupplierPayables?: GatewayRoute;
  financeReviewDigest?: GatewayRoute;
  financeAnomalyMonitor?: GatewayRoute;
  financeEventsConsumer?: GatewayRoute;
  automationEvents?: GatewayRoute;
  dailyOperations?: GatewayRoute;
}

export function createGateway(key: string, routes: GatewayRoutes) {
  if (key.length < 32) throw new Error('GATEWAY_KEY_TOO_SHORT');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash(key);
  // Explicit route table. There is deliberately no generic proxy: no caller-supplied target URL,
  // no forwarded HTTP method, no wildcard route, no query strings.
  const table = new Map<string, GatewayRoute>([
    ['/internal/workflows/paid-order-confirmation/run', routes.paidOrder],
    ['/internal/workflows/referral-qualification/run', routes.referral],
  ]);
  if (routes.adminNotification) table.set('/internal/notifications/automation-error', routes.adminNotification);
  if (routes.productRequests) table.set('/internal/workflows/product-request-notification/run', routes.productRequests);
  if (routes.lowStock) table.set('/internal/workflows/low-stock-notification/run', routes.lowStock);
  if (routes.orderOperations) table.set('/internal/workflows/order-operations/run', routes.orderOperations);
  if (routes.reconciliation) table.set('/internal/workflows/payment-reconciliation/run', routes.reconciliation);
  if (routes.shippingSla) table.set('/internal/workflows/shipping-sla/run', routes.shippingSla);
  if (routes.systemHealth) table.set('/internal/workflows/system-health/run', routes.systemHealth);
  if (routes.financeDailyReport) table.set('/internal/workflows/finance-daily-report/run', routes.financeDailyReport);
  if (routes.financeWeeklyReport) table.set('/internal/workflows/finance-weekly-report/run', routes.financeWeeklyReport);
  if (routes.financeReconciliation) table.set('/internal/workflows/finance-reconciliation/run', routes.financeReconciliation);
  if (routes.financeExpenseReview) table.set('/internal/workflows/finance-expense-review/run', routes.financeExpenseReview);
  if (routes.financeSupplierPayables) table.set('/internal/workflows/finance-supplier-payables/run', routes.financeSupplierPayables);
  if (routes.financeReviewDigest) table.set('/internal/workflows/finance-review-digest/run', routes.financeReviewDigest);
  if (routes.financeAnomalyMonitor) table.set('/internal/workflows/finance-anomaly-monitor/run', routes.financeAnomalyMonitor);
  if (routes.financeEventsConsumer) table.set('/internal/workflows/finance-events-consumer/run', routes.financeEventsConsumer);
  if (routes.automationEvents) table.set('/internal/workflows/automation-events/run', routes.automationEvents);
  if (routes.dailyOperations) table.set('/internal/workflows/daily-operations-summary/run', routes.dailyOperations);
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    const supplied = req.headers['x-gateway-key'];
    if (typeof supplied !== 'string' || !timingSafeEqual(hash(supplied), expected)) { reply(401, { code: 'GATEWAY_AUTHENTICATION_FAILED' }); return; }
    if (req.url === '/internal/health' && req.method === 'GET') { reply(200, { status: 'alive', upstreamChecked: false }); return; }
    const route = typeof req.url === 'string' ? table.get(req.url) : undefined;
    if (!route) { reply(404, { code: 'NOT_FOUND' }); return; }
    if (req.method !== 'POST') { reply(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(415, { code: 'JSON_REQUIRED' }); return; }
    try {
      const maxBytes = route.bodyMode === 'automation-error' ? 4096 : 1024;
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { reply(413, { code: 'BODY_TOO_LARGE' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { code: 'INVALID_BODY' }); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (route.bodyMode !== 'automation-error' && Object.keys(value).length)) {
        reply(400, { code: 'INVALID_BODY' }); return;
      }
      const result = await route.run(value);
      const status = result.status === 'failed' ? 502 : result.status === 'busy' ? 409 : 200;
      reply(status, result);
    } catch (error) {
      const code = safeCode(error);
      const failureCategory = classifyFailure(error);
      const transient = ['RATE_LIMITED', 'ALVERON_SERVER_ERROR', 'NETWORK_ERROR'].includes(failureCategory);
      reply(code === 'VALIDATION_FAILED' ? 400 : 502, {
        status: 'failed', code, failureCategory, transient,
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
