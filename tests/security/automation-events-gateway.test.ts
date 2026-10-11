import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { AlveronClient } from '../../src/integrations/alveron/client.js';
import { HttpTransport } from '../../src/integrations/alveron/http.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { createGateway, type GatewayRoute } from '../../src/gateway/server.js';

const config = () => loadConfig({
  NODE_ENV: 'test', ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'fixture@example.invalid', ALVERON_SERVICE_PASSWORD: 'fixture-password',
  ADMIN_ALERT_EMAIL: 'admin@example.invalid', GATEWAY_API_KEY: 'k'.repeat(48),
  LEDGER_DATABASE_URL: 'sqlite:./data/ledger.sqlite',
});

const attempt = () => {
  const captured: { method: string; url: string }[] = [];
  const http = new HttpTransport(config(), createLogger('silent'), (async (url: string, init?: RequestInit) => {
    captured.push({ method: init?.method ?? 'GET', url: String(url) });
    const body = init?.method === 'POST'
      ? { id: uuid, status: 'delivered' }
      : { items: [], total: 0, page: 1, pageSize: 50, pages: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
  const client = new AlveronClient(http, { getSession: async () => ({ token: 't', expiresAt: Date.now() + 60000 }) } as never);
  return { captured, client, http };
};

const uuid = '00000000-0000-4000-8000-000000000001';

test('the automation outbox allowlist accepts only bounded reads and a single ack', async () => {
  const { captured, client, http } = attempt();
  await client.listAutomationEvents('pending', 1, 50);
  assert.match(captured[0]!.url, /\/admin\/automation\/events\?status=pending&page=1&pageSize=50$/);
  await client.ackAutomationEvent(uuid);
  assert.equal(captured[1]!.method, 'POST');
  assert.match(captured[1]!.url, new RegExp(`/admin/automation/events/${uuid}/ack$`));

  for (const path of [
    '/admin/automation/events?status=pending&page=1&pageSize=50&all=1',
    '/admin/automation/events/../finance/events',
    `/admin/automation/events/${uuid}`,
    '/admin/automation/events?page=abc',
    '/admin/automation/events?status=delivered&status=pending',
  ]) {
    const before = captured.length;
    await assert.rejects(() => http.request('GET', path, 'token'), { code: 'VALIDATION_FAILED' }, path);
    assert.equal(captured.length, before, `no request may leave the process for ${path}`);
  }
});

test('the automation gateway routes require the key and reject caller bodies and proxying', async () => {
  const key = 'synthetic-automation-gateway-key-0001';
  const route = (): GatewayRoute => ({ run: async () => ({ status: 'completed' }) });
  const server = createGateway(key, { paidOrder: route(), referral: route(),
    automationEvents: route(), dailyOperations: route() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}`;
  const call = (path: string, supplied: string, body = '{}') => fetch(root + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': supplied }, body,
  });
  const paths = ['/internal/workflows/automation-events/run', '/internal/workflows/daily-operations-summary/run'];
  try {
    for (const path of paths) {
      assert.equal((await call(path, '')).status, 401);
      assert.equal((await call(path, 'wrong-key')).status, 401);
      assert.equal((await call(path, key, '{"paidOrders":999}')).status, 400);
      assert.equal((await call(path, key)).status, 200);
    }
    assert.equal((await call('/admin/automation/events', key)).status, 404, 'no generic proxy');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
