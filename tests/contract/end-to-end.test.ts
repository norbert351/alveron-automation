import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { makeApplication } from '../../src/gateway/application.js';
import { createGateway } from '../../src/gateway/server.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

test('MOCK HTTP end-to-end: gateway login, discover, detail, customer + admin, persistent duplicate suppression', async () => {
  const orderId = randomUUID(); const userId = randomUUID(); const token = randomUUID();
  const gatewayKey = randomUUID(); const password = randomUUID();
  // Synthetic already-paid order: this test never creates or changes Alveron orders.
  const order = { id: orderId, order_number: 42, status: 'paid', payment_status: 'SUCCESS',
    customer_name: 'Synthetic Customer', customer_email: 'synthetic@example.invalid',
    subtotal: 30000, discount: 0, shipping: 2000, total: 32000, currency: 'NGN',
    items: [{ title: 'Synthetic item', variant_title: 'M', quantity: 1, price: 30000 }],
    payments: [{ id: randomUUID(), order_id: orderId, provider_reference: 'synthetic-reference', amount: 3200000, currency: 'NGN', status: 'SUCCESS' }] };
  const requests: string[] = []; const notifications: string[] = [];
  const upstream = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/auth/admin-login') {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { email: string; password: string };
      if (body.password !== password) { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify({ user: { id: userId }, session: { access_token: token, expires_in: 3600 },
        employee: { user_id: userId, status: 'active', role: { slug: 'admin' } }, profile: { id: userId, role: 'admin', status: 'active' } }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{}'); return; }
    if (req.method === 'GET' && req.url === '/api/orders') { res.end(JSON.stringify([order])); return; }
    if (req.method === 'GET' && req.url === `/api/orders/${orderId}`) { res.end(JSON.stringify({ ...order, events: [] })); return; }
    res.statusCode = 404; res.end('{}');
  });
  const root = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'alveron-e2e-'));
  const config = loadConfig({ ALVERON_API_BASE_URL: `${root}/api`, ALVERON_SERVICE_EMAIL: 'automation@example.invalid',
    ALVERON_SERVICE_PASSWORD: password, GATEWAY_API_KEY: gatewayKey, ADMIN_ALERT_EMAIL: 'admin@example.invalid',
    LEDGER_DATABASE_URL: `sqlite:${join(dir, 'ledger.sqlite')}`, EMAIL_PROVIDER: 'console', LOG_LEVEL: 'silent' });
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { notifications.push(args.map(String).join(' ')); };
  const application = makeApplication(config);
  const gateway = createGateway(gatewayKey, { paidOrder: application.workflow, referral: application.referral });
  const gatewayRoot = await listen(gateway);
  try {
    const run = async () => {
      const response = await fetch(`${gatewayRoot}/internal/workflows/paid-order-confirmation/run`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': gatewayKey }, body: '{}',
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      for (const secret of [token, password, gatewayKey, order.customer_email]) assert.equal(raw.includes(secret), false);
      return JSON.parse(raw) as { processed: number; skipped: number; failed: number };
    };
    const first = await run(); assert.equal(first.processed, 1); assert.equal(first.failed, 0);
    const second = await run(); assert.equal(second.processed, 0); assert.equal(second.skipped, 1);
    assert.equal(notifications.length, 2);
    assert.ok(notifications.some(line => line.includes('customer_confirmation')));
    assert.ok(notifications.some(line => line.includes('admin_alert')));
    assert.equal(requests.filter(path => path.includes('admin-login')).length, 1);
    assert.equal(requests.filter(path => path === 'GET /api/orders').length, 2);
    assert.equal(requests.filter(path => path === `GET /api/orders/${orderId}`).length, 2);
    assert.ok(requests.every(path => path.startsWith('GET ') || path === 'POST /api/auth/admin-login'));
    assert.equal(application.ledger.get(`development-console:paid-order-confirmation:${orderId}:customer`)?.status, 'SUCCESS');
    assert.equal(application.ledger.get(`development-console:paid-order-confirmation:${orderId}:admin`)?.status, 'SUCCESS');
  } finally {
    console.log = originalLog; await close(gateway); await close(upstream); application.ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
