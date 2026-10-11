import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { AlveronClient } from '../../src/integrations/alveron/client.js';
import { HttpTransport } from '../../src/integrations/alveron/http.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { createGateway } from '../../src/gateway/server.js';

const config = (env: Record<string, string> = {}) => loadConfig({
  NODE_ENV: 'test',
  ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'fixture@example.invalid',
  ALVERON_SERVICE_PASSWORD: 'fixture-password',
  ADMIN_ALERT_EMAIL: 'admin@example.invalid',
  GATEWAY_API_KEY: 'k'.repeat(48),
  LEDGER_DATABASE_URL: 'sqlite:./data/ledger.sqlite',
  ...env,
});

/** Exercises the real transport allowlist without any network call. */
const attempt = () => {
  const captured: string[] = [];
  const http = new HttpTransport(config(), createLogger('silent'), (async (url: string) => {
    captured.push(url);
    return new Response('{"items":[],"total":0}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
  const client = new AlveronClient(http, { getSession: async () => ({ token: 't', expiresAt: Date.now() + 60000 }) } as never);
  return { captured, client, http };
};

test('paged catalog and product-request reads are allowed, and the allowlist rejects everything else', async () => {
  const { captured, client } = attempt();
  await client.getProductCatalog(50, 0);
  assert.match(captured[0]!, /\/products\?limit=50&offset=0$/);

  const requests = attempt();
  await requests.client.getProductRequests(1, 25);
  assert.match(requests.captured[0]!, /\/admin\/product-requests\?page=1&pageSize=25$/);
});

test('the read allowlist refuses path traversal, extra keys, non-numeric paging and unknown routes', async () => {
  const refused = [
    // Traversal: a normalised URL would silently become a different, allowlisted endpoint.
    '/products/../orders', '/products/../../admin/users', '/admin/product-requests/../orders',
    // Extra or unexpected query keys, and non-numeric paging values.
    '/products?limit=50&callback=http://evil', '/products?limit=abc', '/products?limit=50&secret=1',
    '/admin/product-requests?page=1&pageSize=25&all=1', '/admin/product-requests?page=1;drop',
    '/products?limit=99999999999', // longer than the 4-digit bound
    // Endpoints outside the allowlist, including write-capable admin surfaces.
    '/products/1', '/admin/stats', '/admin/analytics', '/admin/orders', '/referrals/admin/all',
    '/admin/customers', '/upload', '/orders/00000000-0000-4000-8000-000000000001/events',
  ];
  for (const path of refused) {
    const { captured, http } = attempt();
    await assert.rejects(() => http.request('GET', path, 'token'), { code: 'VALIDATION_FAILED' }, path);
    assert.deepEqual(captured, [], `no request may leave the process for ${path}`);
  }
});

test('product-request and low-stock paging arguments are bounded before any request is built', async () => {
  const { client } = attempt();
  const badPaging: [number, number][] = [[0, 0], [101, 0], [50, -1], [50, 999999]];
  for (const [limit, offset] of badPaging) {
    await assert.rejects(() => client.getProductCatalog(limit, offset), { code: 'VALIDATION_FAILED' });
  }
  const badPages: [number, number][] = [[0, 25], [1, 0], [1, 101], [1001, 25]];
  for (const [page, size] of badPages) {
    await assert.rejects(() => client.getProductRequests(page, size), { code: 'VALIDATION_FAILED' });
  }
});

test('the new notification routes require gateway authentication and reject any body', async () => {
  const key = 'k'.repeat(48);
  const ok = { status: 'accepted' };
  const server = createGateway(key, {
    paidOrder: { async run() { return ok; } },
    referral: { async run() { return ok; } },
    productRequests: { async run() { return ok; } },
    lowStock: { async run() { return ok; } },
    orderOperations: { async run() { return ok; } },
    reconciliation: { async run() { return ok; } },
    shippingSla: { async run() { return ok; } },
    systemHealth: { async run() { return ok; } },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/internal/workflows/product-request-notification/run',
      '/internal/workflows/low-stock-notification/run',
      '/internal/workflows/order-operations/run',
      '/internal/workflows/payment-reconciliation/run',
      '/internal/workflows/shipping-sla/run',
      '/internal/workflows/system-health/run']) {
      const unauthenticated = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(unauthenticated.status, 401, path);
      const authenticated = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': key }, body: '{}',
      });
      assert.equal(authenticated.status, 200, path);
      // A caller-supplied chat id or destination must never be accepted.
      const injected = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': key },
        body: JSON.stringify({ chatId: '@attacker', adminChatId: '1' }),
      });
      assert.equal(injected.status, 400, path);
      const get = await fetch(`${base}${path}`, { headers: { 'x-gateway-key': key } });
      assert.equal(get.status, 405, path);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the gateway exposes no Telegram passthrough or wildcard proxy route', async () => {
  const key = 'k'.repeat(48);
  const server = createGateway(key, {
    paidOrder: { async run() { return { status: 'accepted' }; } },
    referral: { async run() { return { status: 'accepted' }; } },
    productRequests: { async run() { return { status: 'accepted' }; } },
    lowStock: { async run() { return { status: 'accepted' }; } },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/internal/notifications/telegram', '/internal/telegram/send',
      '/internal/notifications/send', '/internal/proxy', '/internal/workflows/../admin/users',
      '/internal/notifications/automation-error/../../admin']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': key }, body: '{}',
      });
      assert.equal(response.status, 404, path);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
