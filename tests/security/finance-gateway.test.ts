import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway, type GatewayRoute } from '../../src/gateway/server.js';

const criticalRoute = (): GatewayRoute => ({ run: async () => ({ status: 'completed' }) });

/**
 * The finance routes are additive entries in the same explicit route table as every other workflow.
 * This proves: (1) all eight are registered; (2) an unauthenticated request is rejected; (3) a
 * caller-supplied arbitrary body is rejected (no finance numbers can be injected by a caller); and
 * (4) there is still no generic proxy, so `/admin/finance/*` cannot be reached directly.
 */
test('finance gateway routes exist, require the key, and reject arbitrary bodies', async () => {
  const key = 'synthetic-finance-gateway-key-0000001';
  const routes = {
    paidOrder: criticalRoute(), referral: criticalRoute(),
    financeDailyReport: criticalRoute(), financeWeeklyReport: criticalRoute(),
    financeReconciliation: criticalRoute(), financeExpenseReview: criticalRoute(),
    financeSupplierPayables: criticalRoute(), financeReviewDigest: criticalRoute(),
    financeAnomalyMonitor: criticalRoute(), financeEventsConsumer: criticalRoute(),
  };
  const server = createGateway(key, routes);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}`;
  const paths = [
    '/internal/workflows/finance-daily-report/run',
    '/internal/workflows/finance-weekly-report/run',
    '/internal/workflows/finance-reconciliation/run',
    '/internal/workflows/finance-expense-review/run',
    '/internal/workflows/finance-supplier-payables/run',
    '/internal/workflows/finance-review-digest/run',
    '/internal/workflows/finance-anomaly-monitor/run',
    '/internal/workflows/finance-events-consumer/run',
  ];
  const call = (path: string, supplied: string, body = '{}') => fetch(root + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': supplied }, body,
  });
  try {
    for (const path of paths) {
      assert.equal((await call(path, '')).status, 401, `${path} must reject a missing key`);
      assert.equal((await call(path, 'wrong-key')).status, 401, `${path} must reject a wrong key`);
      // A caller cannot inject financial values: any non-empty body is rejected.
      assert.equal((await call(path, key, '{"revenue":999}')).status, 400, `${path} must reject a caller body`);
      assert.equal((await call(path, key)).status, 200);
    }
    // The finance upstream is not proxied: the raw Alveron path is not a route.
    assert.equal((await call('/admin/finance/overview', key)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
