import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { HttpTransport } from '../../src/integrations/alveron/http.js';
import { AuthManager } from '../../src/integrations/alveron/auth.js';
import { AlveronClient, FINANCE_ENDPOINTS, FINANCE_EVENTS_PATH } from '../../src/integrations/alveron/client.js';

/**
 * Real local HTTP contract for the finance client: it authenticates, reads each configured finance
 * path, and returns parsed data. It also proves the two security invariants:
 *   - a 404 on a finance contract that Alveron does not serve yet surfaces as
 *     `FINANCE_ENDPOINT_UNAVAILABLE` (not a generic failure);
 *   - an arbitrary path is refused by the transport before any outbound request is made.
 */
test('finance client authenticates, reads configured paths, and fails closed on an unserved contract', async () => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/auth/admin-login') {
      for await (const _ of req) { /* drain */ }
      return res.end(JSON.stringify({ session: { access_token: 'fixture-token', expires_in: 300 },
        employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } }));
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (req.url === `/api${FINANCE_ENDPOINTS.dailyReport}`) {
      return res.end(JSON.stringify({ asOf: '2026-10-04T09:00:00.000Z', currency: 'NGN',
        period: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T23:59:59.000Z' },
        current: { revenue: 500000, cogs: 300000 }, previous: null }));
    }
    // Finance outbox: a bounded pending page and the typed ack.
    if (req.url === `/api${FINANCE_EVENTS_PATH}?status=pending&page=1&pageSize=50`) {
      return res.end(JSON.stringify({ items: [{ id: '00000000-0000-4000-8000-000000000001',
        event_type: 'owner_transaction_recorded', payload: { type: 'owner_draw', amountMinor: 100 },
        status: 'pending', idempotency_key: 'owner_tx:00000000-0000-4000-8000-000000000009',
        created_at: '2026-10-04T09:00:00.000Z', delivered_at: null, review_status: null }],
        total: 1, page: 1, pageSize: 50, pages: 1 }));
    }
    if (req.method === 'POST' && req.url === `/api${FINANCE_EVENTS_PATH}/00000000-0000-4000-8000-000000000001/ack`) {
      return res.end(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', status: 'delivered' }));
    }
    // Every other finance path is not served yet.
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const config = loadConfig({ ALVERON_API_BASE_URL: `http://127.0.0.1:${address.port}/api`,
      ALVERON_SERVICE_EMAIL: 'automation@example.test', ALVERON_SERVICE_PASSWORD: 'fixture-password',
      GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.test',
      LEDGER_DATABASE_URL: 'sqlite:fixture.sqlite' });
    const logger = createLogger('silent');
    const http = new HttpTransport(config, logger);
    const client = new AlveronClient(http, new AuthManager(http, logger));

    const report = await client.getFinanceDailyReport();
    assert.equal(report.current.revenue, 500000);
    assert.equal(report.current.cogs, 300000);
    assert.equal(report.current.netProfit, null);

    await assert.rejects(() => client.getFinanceWeeklyReport(), (error: unknown) =>
      error instanceof Error && 'code' in error && (error as { code: string }).code === 'FINANCE_ENDPOINT_UNAVAILABLE');

    // The typed outbox read and acknowledge round-trip over the authenticated transport.
    const events = await client.listFinanceEvents('pending', 1, 50);
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0]!.eventType, 'owner_transaction_recorded');
    assert.equal(events.items[0]!.idempotencyKey, 'owner_tx:00000000-0000-4000-8000-000000000009');
    const ack = await client.ackFinanceEvent(events.items[0]!.id);
    assert.equal(ack.status, 'delivered');

    // No arbitrary path can reach the network: the transport allowlist rejects it internally.
    await assert.rejects(() => http.request('GET', '/admin/finance/overview?period=1d', 'fixture-token'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'VALIDATION_FAILED');
    // An unbounded/foreign outbox query is refused; only the typed pagination triple is allowed.
    await assert.rejects(() => http.request('GET', `${FINANCE_EVENTS_PATH}?status=pending&page=1&pageSize=50&extra=1`, 'fixture-token'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'VALIDATION_FAILED');
    await assert.rejects(() => http.request('POST', '/admin/finance/transactions', 'fixture-token'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'VALIDATION_FAILED');
    assert.equal(requests.some(entry => entry.includes('?period=')), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
