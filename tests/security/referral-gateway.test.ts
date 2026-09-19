import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { ReferralQualificationWorkflow } from '../../src/workflows/referral-qualification.js';
import { createGateway } from '../../src/gateway/server.js';

const stats = { total: 4, pending: 1, qualified: 1, rewarded: 1, cancelled: 1,
  totalDiscounts: 2000, totalRewards: 1000, totalCreditIssued: 1000, totalCreditRedeemed: 0, conversionRate: 50 };
const t10 = Date.parse('2026-09-16T10:00:00Z');
const ROUTE = '/internal/workflows/referral-qualification/run';

async function withGateway(
  client: { triggerReferralProcessing(): Promise<typeof stats> },
  body: (root: string, key: string) => Promise<void>,
) {
  const key = randomUUID();
  const ledger = new SqliteLedger(':memory:');
  const referral = new ReferralQualificationWorkflow(client, ledger, 60, () => t10);
  const paidOrder = { run: async () => ({ status: 'duplicate' }) };
  const server = createGateway(key, { paidOrder, referral });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    await body(`http://127.0.0.1:${address.port}`, key);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
  }
}
const post = (root: string, key: string, path = ROUTE, body = '{}') => fetch(root + path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': key }, body,
});

test('the referral route requires the gateway key and issues no upstream call without it', async () => {
  let calls = 0;
  await withGateway({ triggerReferralProcessing: async () => { calls++; return stats; } }, async (root, key) => {
    assert.equal((await post(root, '')).status, 401);
    assert.equal((await post(root, 'wrong-key'.padEnd(40, 'x'))).status, 401);
    assert.equal((await post(root, randomUUID())).status, 401);
    assert.equal(calls, 0, 'unauthenticated callers must never reach Alveron');
    assert.equal((await post(root, key)).status, 200);
    assert.equal(calls, 1);
  });
});

test('the referral route has no proxy behaviour and rejects malformed or extra bodies', async () => {
  await withGateway({ triggerReferralProcessing: async () => stats }, async (root, key) => {
    for (const path of ['/internal/proxy', '/internal/alveron', '/internal/request',
      '/alveron/referrals/admin/stats', '/internal/workflows/referral-qualification',
      `${ROUTE}?target=https://example.invalid`]) {
      assert.equal((await post(root, key, path)).status, 404, `${path} must not exist`);
    }
    assert.equal((await post(root, key, ROUTE, '{')).status, 400);
    assert.equal((await post(root, key, ROUTE, '{"url":"https://example.invalid"}')).status, 400);
    assert.equal((await post(root, key, ROUTE, '{"windowId":"2020-01-01T00:00Z"}')).status, 400);
    assert.equal((await fetch(`${root}${ROUTE}`, { method: 'GET', headers: { 'x-gateway-key': key } })).status, 405);
  });
});

test('the referral response is sanitized and never returns secrets or customer data', async () => {
  const secret = randomUUID();
  await withGateway({ triggerReferralProcessing: async () => stats }, async (root, key) => {
    const response = await post(root, key);
    const raw = await response.text();
    assert.equal(response.status, 200);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed['status'], 'completed');
    assert.equal(parsed['endpoint'], '/referrals/admin/stats');
    assert.equal(parsed['processedCount'], null);
    for (const forbidden of [key, secret, 'synthetic-token', 'Bearer ', 'password',
      'access_token', 'refresh_token', 'service_role', '@']) {
      assert.equal(raw.includes(forbidden), false, `response must not contain ${forbidden}`);
    }
    for (const field of ['runId', 'windowId', 'startedAt', 'completedAt', 'durationMs']) {
      assert.ok(field in parsed, `expected ${field}`);
    }
  });
});

test('a second run in the same window is a 200 duplicate, not an error and not a second call', async () => {
  let calls = 0;
  await withGateway({ triggerReferralProcessing: async () => { calls++; return stats; } }, async (root, key) => {
    assert.equal((await post(root, key)).status, 200);
    const second = await post(root, key);
    assert.equal(second.status, 200, 'a duplicate window is a legitimate no-op, not a failure');
    assert.equal((await second.json() as { status: string }).status, 'duplicate');
    assert.equal(calls, 1);
  });
});

test('an Alveron failure surfaces as a 502 with an explicit category and no success claim', async () => {
  await withGateway({ triggerReferralProcessing: async () => { throw new Error('upstream exploded'); } }, async (root, key) => {
    const response = await post(root, key);
    assert.equal(response.status, 502);
    const raw = await response.text();
    const parsed = JSON.parse(raw) as { status: string; failureCategory: string; sideEffectInvoked: boolean };
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.failureCategory, 'UNKNOWN_ERROR');
    assert.equal(parsed.sideEffectInvoked, false);
    assert.equal(raw.includes('upstream exploded'), false, 'raw upstream text must not leak');
  });
});