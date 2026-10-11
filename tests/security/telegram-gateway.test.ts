import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createGateway } from '../../src/gateway/server.js';
import { AutomationErrorNotificationRoute } from '../../src/gateway/admin-notification-route.js';
import type { AdminNotification, AdminNotificationResult, AdminNotifier } from '../../src/providers/admin/index.js';

const key = 'synthetic-test-key-not-a-secret-0001';
const validBody = {
  workflow: 'Paid Order Confirmation', executionId: 'execution-123', category: 'ALVERON_SERVER_ERROR',
  errorCode: 'ALVERON_API_FAILURE', transient: true,
};

async function withRoute(
  notifier: AdminNotifier,
  body: (root: string, call: (payload?: unknown) => Promise<Response>) => Promise<void>,
) {
  const route = new AutomationErrorNotificationRoute(notifier);
  const server = createGateway(key, {
    paidOrder: { run: async () => ({ status: 'completed' }) },
    referral: { run: async () => ({ status: 'duplicate' }) },
    adminNotification: route,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const call = async (payload: unknown = validBody) => fetch(`http://127.0.0.1:${address.port}/internal/notifications/automation-error`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': key },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload), redirect: 'error',
  });
  try { await body(`http://127.0.0.1:${address.port}`, call); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('automation error route requires gateway authentication and rejects arbitrary fields', async () => {
  let notifications = 0;
  const notifier: AdminNotifier = {
    notify: async () => { notifications++; return { status: 'SUCCESS', simulated: true }; },
  };
  await withRoute(notifier, async (root, call) => {
    const unauthenticated = await fetch(`${root}/internal/notifications/automation-error`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await call({ ...validBody, chatId: 'attacker-selected' })).status, 400);
    assert.equal((await call({ ...validBody, errorCode: 'RAW_SECRET_ERROR' })).status, 400);
    assert.equal((await call('{')).status, 400);
    assert.equal((await call(validBody)).status, 200);
    assert.equal(notifications, 1);
  });
});

test('automation error notification failure is accepted without failing the n8n error workflow', async () => {
  const notifier: AdminNotifier = { notify: async () => { throw new Error('synthetic provider failure'); } };
  await withRoute(notifier, async (_root, call) => {
    const response = await call();
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(raw), { status: 'accepted', adminNotificationStatus: 'FAILED' });
    assert.equal(raw.includes('synthetic provider failure'), false);
  });
});

test('automation error route passes only canonical, bounded notification data', async () => {
  let received: AdminNotification | undefined;
  const notifier: AdminNotifier = {
    notify: async (notification: AdminNotification): Promise<AdminNotificationResult> => {
      received = notification; return { status: 'SUCCESS', simulated: true };
    },
  };
  await withRoute(notifier, async (_root, call) => {
    assert.equal((await call()).status, 200);
    assert.match(String(received?.eventKey), /^automation-error:[0-9a-f]{64}$/);
    assert.equal(received?.kind, 'AUTOMATION_ERROR');
    assert.equal(JSON.stringify(received).includes('chatId'), false);
    assert.equal((await call({ ...validBody, executionId: 'e'.repeat(200),
      errorCode: 'GATEWAY_AUTHENTICATION_FAILED' })).status, 200);
    assert.equal(received?.resourceId, 'e'.repeat(200));
  });
});
