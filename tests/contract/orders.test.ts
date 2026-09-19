import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { HttpTransport } from '../../src/integrations/alveron/http.js';
import { AuthManager } from '../../src/integrations/alveron/auth.js';

const id = '00000000-0000-4000-8000-000000000001';

test('real local HTTP contract: admin-login then bearer-authenticated single-order GET', async () => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/auth/admin-login') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        email: 'automation@example.test', password: 'fixture-password',
      });
      res.end(JSON.stringify({ session: { access_token: 'fixture-token', expires_in: 300 },
        employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } }));
    } else if (req.method === 'GET' && req.url === `/api/orders/${id}`) {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      res.end(JSON.stringify({ id }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const config = loadConfig({ ALVERON_API_BASE_URL: `http://127.0.0.1:${address.port}/api`,
      ALVERON_SERVICE_EMAIL: 'automation@example.test', ALVERON_SERVICE_PASSWORD: 'fixture-password',
      GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.test', LEDGER_DATABASE_URL: 'sqlite:fixture.sqlite' });
    const logger = createLogger('silent');
    const http = new HttpTransport(config, logger);
    const auth = new AuthManager(http, logger);
    const session = await auth.getSession();
    assert.deepEqual(await http.request('GET', `/orders/${id}`, session.token), { id });
    assert.deepEqual(requests, ['POST /api/auth/admin-login', `GET /api/orders/${id}`]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
