import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { HttpTransport, RequestScheduler } from '../../src/integrations/alveron/http.js';
import { AuthManager } from '../../src/integrations/alveron/auth.js';
import { isPaid, parseOrders } from '../../src/integrations/alveron/schemas.js';

const env = { ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'synthetic@example.invalid', ALVERON_SERVICE_PASSWORD: 'synthetic-password',
  GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.invalid',
  LEDGER_DATABASE_URL: 'sqlite:synthetic.sqlite' };
const config = loadConfig(env);
function transport(handler: typeof fetch, retries = 2, timeout = 100) {
  let now = 0;
  return new HttpTransport({ ...config, maxRetries: retries, timeoutMs: timeout }, createLogger('silent'), handler,
    new RequestScheduler({ now: () => now, sleep: async ms => { now += ms; } }));
}
const session = () => Response.json({ session: { access_token: 'synthetic-token', expires_in: 60 },
  employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } });

test('config accepts exact required names and rejects missing values, writes, production and nonlocal URLs', () => {
  assert.ok(config.ledgerPath.endsWith('synthetic.sqlite'));
  for (const name of Object.keys(env)) assert.throws(() => loadConfig({ ...env, [name]: '' }));
  for (const extra of [{ FEATURE_ENABLE_ALVERON_WRITES: 'true' }, { NODE_ENV: 'production' },
    { GATEWAY_API_KEY: 'short' }, { ALVERON_API_BASE_URL: 'https://example.invalid/api' }]) {
    assert.throws(() => loadConfig({ ...env, ...extra }));
  }
});

test('auth success is single-flight, reuses token, and reauthenticates after expiry', async () => {
  let calls = 0; let now = 0;
  const http = transport(async () => { calls++; return session(); });
  const auth = new AuthManager(http, createLogger('silent'), () => now);
  const [a,b] = await Promise.all([auth.getSession(), auth.getSession()]);
  assert.equal(a,b); assert.equal(calls,1);
  assert.equal(await auth.getSession(), a);
  now = 61000;
  assert.notEqual(await auth.getSession(), a); assert.equal(calls,2);
});

test('failed auth fails closed and does not retry login', async () => {
  let calls = 0;
  const auth = new AuthManager(transport(async () => { calls++; return Response.json({}, { status: 401 }); }), createLogger('silent'));
  await assert.rejects(auth.getSession(), { message: 'AUTHENTICATION_FAILED' }); assert.equal(calls,1);
});

for (const status of [429, 500, 502, 503, 504]) {
  test(`GET retries transient ${status} then succeeds`, async () => {
    let calls = 0;
    const http = transport(async () => ++calls === 1 ? Response.json({}, { status, headers: { 'retry-after': '0' } }) : Response.json([]));
    assert.deepEqual(await http.request('GET', '/orders', 'synthetic'), []); assert.equal(calls,2);
  });
}
for (const status of [400, 401, 403, 404]) {
  test(`GET does not retry ${status}`, async () => {
    let calls = 0;
    const http = transport(async () => { calls++; return Response.json({}, { status }); });
    await assert.rejects(http.request('GET', '/orders', 'synthetic')); assert.equal(calls,1);
  });
}
test('timeout is bounded and retry count is finite', async () => {
  let calls = 0;
  const http = transport(async () => { calls++; return new Promise<Response>(() => {}); }, 1, 10);
  await assert.rejects(http.request('GET', '/orders', 'synthetic')); assert.equal(calls,2);
});
test('malformed JSON is not retried or interpreted as no orders', async () => {
  let calls = 0;
  const http = transport(async () => { calls++; return new Response('{', { headers: { 'content-type': 'application/json' } }); });
  await assert.rejects(http.request('GET', '/orders', 'synthetic')); assert.equal(calls,1);
});
test('unknown/unpaid statuses fail closed; invalid list is not empty', () => {
  for (const status of ['SUCCESS','paid','success']) assert.equal(isPaid(status), true);
  for (const status of ['PENDING','pending','VERIFICATION_FAILED','unknown']) assert.equal(isPaid(status), false);
  assert.deepEqual(parseOrders([]), []); assert.throws(() => parseOrders({}));
});
test('logger drops credentials and payloads even if accidentally supplied', () => {
  const lines: string[] = [];
  createLogger('info', line => lines.push(line)).log('http_failure', { password: env.ALVERON_SERVICE_PASSWORD,
    token: 'synthetic-token', authorization: 'Bearer synthetic-token', body: env, code: 'ALVERON_API_FAILURE' });
  assert.equal(lines.join('').includes('synthetic'), false);
});
