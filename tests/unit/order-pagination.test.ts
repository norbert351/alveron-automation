import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { HttpTransport, RequestScheduler } from '../../src/integrations/alveron/http.js';
import { AuthManager } from '../../src/integrations/alveron/auth.js';
import { AlveronClient } from '../../src/integrations/alveron/client.js';
import { parseOrder, type Order } from '../../src/integrations/alveron/schemas.js';

const env = {
  ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'synthetic@example.invalid', ALVERON_SERVICE_PASSWORD: 'synthetic-password',
  GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.invalid',
  LEDGER_DATABASE_URL: 'sqlite:synthetic.sqlite',
};
const config = loadConfig(env);

const order = (n: number): Order => parseOrder({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, order_number: n, status: 'paid',
  payment_status: 'SUCCESS', customer_email: 'fixture@example.invalid', customer_name: 'Fixture',
  total: 1000, subtotal: 1000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Synthetic', variant_title: null, quantity: 1, price: 1000 }], payments: [],
});
const login = () => Response.json({ session: { access_token: 'synthetic-token', expires_in: 3600 },
  employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } });

function harness(handler: typeof fetch, options: { pageSize?: number; maxPages?: number; retries?: number } = {}) {
  let clock = 0;
  const scheduler = new RequestScheduler({ now: () => clock, sleep: async ms => { clock += ms; } });
  const logger = createLogger('silent');
  const http = new HttpTransport({ ...config, maxRetries: options.retries ?? 2, timeoutMs: 500 }, logger, handler, scheduler);
  const auth = new AuthManager(http, logger, () => 1000);
  return new AlveronClient(http, auth, options.pageSize ?? 2, options.maxPages ?? 5);
}

const pageHandler = (pages: (limit: number, offset: number) => unknown, spy?: string[]) => (async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') return login();
  const parsed = new URL(url);
  spy?.push(`${parsed.pathname}?${parsed.searchParams.toString()}`);
  const limit = Number(parsed.searchParams.get('limit'));
  const offset = Number(parsed.searchParams.get('offset'));
  return Response.json(pages(limit, offset));
}) as typeof fetch;

test('a single short page is returned and stops the scan', async () => {
  const calls: string[] = [];
  const client = harness(pageHandler(() => [order(1)], calls));
  const orders = await client.getOrders();
  assert.deepEqual(orders.map(o => o.order_number), [1]);
  assert.equal(calls.length, 1, 'a short page ends the scan immediately');
});

test('multiple pages are stitched in order', async () => {
  const calls: string[] = [];
  const all = [order(1), order(2), order(3)];
  const client = harness(pageHandler((_limit, offset) => all.slice(offset, offset + 2), calls));
  const orders = await client.getOrders();
  assert.deepEqual(orders.map(o => o.order_number), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('an empty final page is handled safely', async () => {
  const all = [order(1), order(2)];
  const client = harness(pageHandler((_limit, offset) => all.slice(offset, offset + 2)));
  assert.deepEqual((await client.getOrders()).map(o => o.order_number), [1, 2]);
});

test('an order duplicated across pages is returned once', async () => {
  const client = harness(pageHandler((_limit, offset) => offset === 0 ? [order(1), order(2)] : [order(2), order(3)]));
  assert.deepEqual((await client.getOrders()).map(o => o.order_number), [1, 2, 3]);
});

test('malformed pagination (non-array page) fails closed and is never treated as empty', async () => {
  let gets = 0;
  const client = harness((async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return login();
    gets += 1;
    return Response.json({ items: [] });
  }) as typeof fetch);
  await assert.rejects(client.getOrders(), { message: 'VALIDATION_FAILED' });
  assert.equal(gets, 1, 'a malformed page is terminal and is not retried');
});

test('an API failure on a later page fails the scan rather than returning a partial list', async () => {
  let gets = 0;
  const client = harness((async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return login();
    gets += 1;
    const offset = Number(new URL(url).searchParams.get('offset'));
    return offset === 0 ? Response.json([order(1), order(2)]) : Response.json({}, { status: 503 });
  }) as typeof fetch, { retries: 1 });
  await assert.rejects(client.getOrders());
  assert.equal(gets, 3, 'first page plus the retried failing page');
});

test('a rate limit on a later page is retried and the scan completes', async () => {
  let gets = 0;
  const client = harness((async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return login();
    gets += 1;
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (offset === 2 && gets === 2) return Response.json({}, { status: 429, headers: { 'retry-after': '0' } });
    return Response.json(offset === 0 ? [order(1), order(2)] : [order(3)]);
  }) as typeof fetch);
  assert.deepEqual((await client.getOrders()).map(o => o.order_number), [1, 2, 3]);
});

test('the transport allowlist accepts bounded order pagination and rejects anything else', async () => {
  const captured: string[] = [];
  const http = new HttpTransport(config, createLogger('silent'), (async (url: string) => {
    captured.push(String(url));
    return Response.json([]);
  }) as typeof fetch);
  assert.deepEqual(await http.request('GET', '/orders?limit=100&offset=0', 'token'), []);
  assert.equal(captured.length, 1);
  for (const path of ['/orders?limit=abc', '/orders?limit=100&offset=0&scope=all',
    '/orders?limit=100&offset=9999999', '/orders/1']) {
    await assert.rejects(() => http.request('GET', path, 'token'), { code: 'VALIDATION_FAILED' }, path);
  }
});

test('the scan stops at the configured maximum page boundary', async () => {
  const calls: string[] = [];
  const client = harness(pageHandler((_limit, offset) => [order(offset + 1), order(offset + 2)], calls),
    { pageSize: 2, maxPages: 2 });
  const orders = await client.getOrders();
  assert.deepEqual(orders.map(o => o.order_number), [1, 2, 3, 4]);
  assert.equal(calls.length, 2, 'never more than maxPages requests');
});
