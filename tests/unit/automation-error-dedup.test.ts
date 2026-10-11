import assert from 'node:assert/strict';
import test from 'node:test';
import { automationErrorNotification, type AdminNotificationProvider } from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';

const failure = {
  workflow: 'Paid Order — Customer Confirmation & Admin Alert (DEV)',
  category: 'CONFIGURATION_ERROR',
  errorCode: 'NOTIFICATION_NOT_SENT',
  transient: false,
} as const;

const at = (iso: string) => () => Date.parse(iso);

test('repeated identical automation failures share one deduplication key', () => {
  const first = automationErrorNotification({ ...failure, executionId: 'exec-1' }, at('2026-10-11T10:00:00Z'));
  const second = automationErrorNotification({ ...failure, executionId: 'exec-2' }, at('2026-10-11T23:30:00Z'));
  assert.match(first.eventKey, /^automation-error:[0-9a-f]{64}$/);
  assert.equal(first.eventKey, second.eventKey);
});

test('distinct failures stay distinct: new error code, category, workflow or day re-alerts', () => {
  const base = automationErrorNotification({ ...failure, executionId: 'exec-1' }, at('2026-10-11T10:00:00Z'));
  const otherCode = automationErrorNotification(
    { ...failure, errorCode: 'GATEWAY_UNAVAILABLE', category: 'NETWORK_ERROR', executionId: 'exec-1' },
    at('2026-10-11T10:00:00Z'));
  const otherWorkflow = automationErrorNotification(
    { ...failure, workflow: 'Referral Qualification', executionId: 'exec-1' }, at('2026-10-11T10:00:00Z'));
  const nextDay = automationErrorNotification({ ...failure, executionId: 'exec-1' }, at('2026-10-12T00:00:00Z'));
  for (const other of [otherCode, otherWorkflow, nextDay]) assert.notEqual(base.eventKey, other.eventKey);
});

test('a persistent failure alerts once per bucket and re-surfaces the next bucket', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => { sends++; return { messageId: 'synthetic', simulated: true }; },
    };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const first = await notifications.notify(
      automationErrorNotification({ ...failure, executionId: 'exec-1' }, at('2026-10-11T10:00:00Z')));
    const repeated = await notifications.notify(
      automationErrorNotification({ ...failure, executionId: 'exec-2' }, at('2026-10-11T23:30:00Z')));
    const nextBucket = await notifications.notify(
      automationErrorNotification({ ...failure, executionId: 'exec-3' }, at('2026-10-12T09:00:00Z')));
    assert.equal(first.status, 'SUCCESS');
    assert.equal(repeated.status, 'SKIPPED');
    assert.equal(nextBucket.status, 'SUCCESS');
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('transient failures use the hourly bucket so they do not collapse to one alert per day', () => {
  const hourOne = automationErrorNotification(
    { ...failure, category: 'NETWORK_ERROR', errorCode: 'GATEWAY_UNAVAILABLE', transient: true, executionId: 'e1' },
    at('2026-10-11T10:05:00Z'));
  const hourTwo = automationErrorNotification(
    { ...failure, category: 'NETWORK_ERROR', errorCode: 'GATEWAY_UNAVAILABLE', transient: true, executionId: 'e2' },
    at('2026-10-11T11:05:00Z'));
  assert.notEqual(hourOne.eventKey, hourTwo.eventKey);
});
