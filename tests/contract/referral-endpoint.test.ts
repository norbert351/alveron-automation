import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { HttpTransport, RequestScheduler } from '../../src/integrations/alveron/http.js';
import { AuthManager } from '../../src/integrations/alveron/auth.js';
import { AlveronClient } from '../../src/integrations/alveron/client.js';
import { classifyFailure } from '../../src/integrations/alveron/errors.js';

const env = { ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'synthetic@example.invalid', ALVERON_SERVICE_PASSWORD: 'synthetic-password',
  GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.invalid',
  LEDGER_DATABASE_URL: 'sqlite:synthetic.sqlite' };
const config = loadConfig(env);
// Synthetic fixture: exact shape of Alveron's getAdminReferralStats() response (aggregates only).
const statsBody = { total: 4, pending: 1, qualified: 1, rewarded: 1, cancelled: 1,
  totalDiscounts: 2000, totalRewards: 1000, totalCreditIssued: 1000, totalCreditRedeemed: 0, conversionRate: 50 };

function harness(handler: typeof fetch, options: { retries?: number; timeoutMs?: number } = {}) {
  let clock = 0;
  const scheduler = new RequestScheduler({ now: () => clock, sleep: async ms => { clock += ms; } });
  const logger = createLogger('silent');
  const http = new HttpTransport({ ...config, maxRetries: options.retries ?? 2, timeoutMs: options.timeoutMs ?? 500 },
    logger, handler, scheduler);
  // Constant clock: the token never expires, so re-auth can only be triggered by a 401.
  const auth = new AuthManager(http, logger, () => 1000);
  return new AlveronClient(http, auth);
}
const login = () => Response.json({ session: { access_token: 'synthetic-token', expires_in: 3600 },
  employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } });

test('real local HTTP contract: admin-login then the referral endpoint with a bearer token', async () => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/auth/admin-login') { res.end(JSON.stringify({
      session: { access_token: 'synthetic-token', expires_in: 3600 },
      employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin' } })); return; }
    if (req.method === 'GET' && req.url === '/api/referrals/admin/stats') {
      assert.equal(req.headers.authorization, 'Bearer synthetic-token');
      res.end(JSON.stringify(statsBody)); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const scoped = loadConfig({ ...env, ALVERON_API_BASE_URL: `http://127.0.0.1:${address.port}/api` });
    const logger = createLogger('silent');
    const http = new HttpTransport(scoped, logger, fetch);
    const clientAtPort = new AlveronClient(http, new AuthManager(http, logger));
    assert.deepEqual(await clientAtPort.triggerReferralProcessing(), statsBody);
    assert.deepEqual(requests, ['POST /api/auth/admin-login', 'GET /api/referrals/admin/stats']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a 401 triggers exactly one re-authentication and then succeeds', async () => {
  let logins = 0; let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') { logins++; return login(); }
    gets++;
    return gets === 1 ? Response.json({}, { status: 401 }) : Response.json(statsBody);
  });
  assert.deepEqual(await client.triggerReferralProcessing(), statsBody);
  assert.equal(logins, 2, 'one initial login plus one re-authentication');
  assert.equal(gets, 2);
});

test('persistent 401 fails closed as an authentication error', async () => {
  let logins = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') { logins++; return login(); }
    return Response.json({}, { status: 401 });
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'AUTHENTICATION_ERROR');
    return true;
  });
  assert.equal(logins, 2);
});

test('403 is permanent: one attempt, authorization category', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++; return Response.json({}, { status: 403 });
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'AUTHORIZATION_ERROR');
    return true;
  });
  assert.equal(gets, 1, '403 must never be retried');
});

test('404 is permanent and not retried', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++; return Response.json({}, { status: 404 });
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'VALIDATION_FAILED');
    return true;
  });
  assert.equal(gets, 1);
});

test('429 is retried and then succeeds', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++;
    return gets === 1 ? Response.json({}, { status: 429, headers: { 'retry-after': '0' } }) : Response.json(statsBody);
  });
  assert.deepEqual(await client.triggerReferralProcessing(), statsBody);
  assert.equal(gets, 2);
});

test('5xx is retried a bounded number of times then classified as a server error', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++; return Response.json({}, { status: 503 });
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'ALVERON_SERVER_ERROR');
    return true;
  });
  assert.equal(gets, 3, 'one attempt plus the two configured retries, then stop');
});

test('a timeout is bounded, retried and classified as a network error', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++;
    return new Promise<Response>(() => { /* never resolves: forces the timeout */ });
  }, { retries: 1, timeoutMs: 20 });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'NETWORK_ERROR');
    return true;
  });
  assert.equal(gets, 2);
});

test('a malformed body is terminal and is never treated as a successful empty result', async () => {
  let gets = 0;
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    gets++;
    return new Response('{', { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'INVALID_RESPONSE');
    return true;
  });
  assert.equal(gets, 1, 'malformed responses must not be retried');
});

test('HTTP 200 with an unexpected shape is a failure, not "nothing to process"', async () => {
  const client = harness(async (_url, init) => {
    if (init?.method === 'POST') return login();
    return Response.json({ total: 1 }); // missing the remaining aggregate fields
  });
  await assert.rejects(client.triggerReferralProcessing(), (error: unknown) => {
    assert.equal(classifyFailure(error), 'INVALID_RESPONSE');
    return true;
  });
});

test('only the confirmed referral path is reachable; everything else is rejected locally', async () => {
  const requests: string[] = [];
  const client = harness(async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return init?.method === 'POST' ? login() : Response.json(statsBody);
  });
  for (const path of ['/referrals/admin/all', '/referrals/me/stats', '/referrals/admin/stats?limit=1',
    '/referrals/admin/settings', '/admin/stats', '/internal/proxy']) {
    await assert.rejects((client as unknown as { read(p: string): Promise<unknown> }).read(path),
      { message: 'VALIDATION_FAILED' });
  }
  // Authentication may be acquired first, but no read may ever be forwarded for these paths.
  const forwarded = requests.filter(request => !request.startsWith('POST '));
  assert.deepEqual(forwarded, [], 'no read may reach Alveron for a non-allowlisted path');
  assert.ok(requests.every(request => request.startsWith('POST ')));
});
