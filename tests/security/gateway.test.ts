import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { ConsoleEmailProvider } from '../../src/providers/email/index.js';
import { PaidOrderWorkflow } from '../../src/workflows/paid-order-confirmation.js';
import { createGateway } from '../../src/gateway/server.js';

// Synthetic, source-shaped fixture. Never fetched from a live environment.
export const fixture = { id: '00000000-0000-4000-8000-000000000001', order_number: 1,
  status: 'paid', payment_status: 'SUCCESS', customer_email: 'fixture@example.invalid', customer_name: 'Fixture',
  total: 32000, subtotal: 32000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Fixture garment', variant_title: null, quantity: 1, price: 32000 }], payments: [] };

test('private gateway rejects keys, proxy, malformed/extra bodies; valid request deduplicates', async () => {
  const ledger = new SqliteLedger(':memory:');
  const lines: string[] = [];
  let reads = 0;
  const client = { getOrders: async () => [parseOrder(fixture)], getOrder: async () => { reads++; return parseOrder(fixture); } };
  const workflow = new PaidOrderWorkflow(client, ledger, new ConsoleEmailProvider(line => lines.push(line)), 'admin@example.invalid');
  const key = 'synthetic-test-key-not-a-secret-0001';
  // The referral route is not exercised here; this stub exists only so the route table is complete.
  const referral = { run: async () => ({ status: 'duplicate' }) };
  const server = createGateway(key, { paidOrder: workflow, referral });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}`;
  const path = '/internal/workflows/paid-order-confirmation/run';
  const call = (body = '{}', supplied = key, route = path) => fetch(root + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': supplied }, body,
  });
  try {
    assert.equal((await call('{}', '')).status, 401);
    assert.equal((await call('{}', 'wrong')).status, 401);
    assert.equal((await call('{}', key, '/alveron/proxy')).status, 404);
    assert.equal((await call('{')).status, 400);
    assert.equal((await call('{"orderId":"arbitrary"}')).status, 400);
    const first = await (await call()).json() as { processed: number };
    assert.equal(first.processed, 1);
    const second = await (await call()).json() as { skipped: number };
    assert.equal(second.skipped, 1);
    assert.equal(reads, 2); assert.equal(lines.length, 2);
    assert.equal(JSON.stringify(first).includes(fixture.customer_email), false);
    assert.equal(JSON.stringify(first).includes(key), false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); ledger.close(); }
});

test('missing customer email fails closed and never sends or records SUCCESS', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const client = { getOrders: async () => [parseOrder(fixture)], getOrder: async () => parseOrder({ ...fixture, customer_email: null }) };
    const workflow = new PaidOrderWorkflow(client, ledger, new ConsoleEmailProvider(() => assert.fail('must not send')), 'admin@example.invalid');
    const result = await workflow.run();
    assert.equal(result.failed, 1);
    assert.equal(result.results[0]?.reason, 'CUSTOMER_EMAIL_MISSING');
    assert.equal(ledger.has(`development-console:paid-order-confirmation:${fixture.id}:customer`), false);
  } finally { ledger.close(); }
});
