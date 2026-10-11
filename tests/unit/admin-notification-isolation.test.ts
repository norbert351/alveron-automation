import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { ConsoleEmailProvider } from '../../src/providers/email/index.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import type { AdminNotificationProvider } from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { PaidOrderWorkflow } from '../../src/workflows/paid-order-confirmation.js';
import { ReferralQualificationWorkflow } from '../../src/workflows/referral-qualification.js';

const paid = parseOrder({
  id: '00000000-0000-4000-8000-000000000001', order_number: 1042, status: 'paid', payment_status: 'SUCCESS',
  customer_email: 'fixture@example.invalid', customer_name: 'Fixture Customer', total: 85000,
  subtotal: 85000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Synthetic item', variant_title: 'M', quantity: 2, price: 42500 }], payments: [],
});
const failedPayment = parseOrder({
  id: '00000000-0000-4000-8000-000000000002', order_number: 1043, status: 'pending', payment_status: 'VERIFICATION_FAILED',
  customer_email: 'fixture@example.invalid', customer_name: null, total: 65000,
  subtotal: 65000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Synthetic item', variant_title: null, quantity: 1, price: 65000 }],
  payments: [{ id: '00000000-0000-4000-8000-000000000003', order_id: '00000000-0000-4000-8000-000000000002',
    provider_reference: 'synthetic-reference', status: 'VERIFICATION_FAILED', amount: 6500000, currency: 'NGN' }],
});
const stats = { total: 4, pending: 1, qualified: 1, rewarded: 1, cancelled: 1,
  totalDiscounts: 2000, totalRewards: 1000, totalCreditIssued: 1000, totalCreditRedeemed: 0, conversionRate: 50 };

test('Telegram failure does not fail or roll back a successfully paid order workflow', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => { throw new NotificationNotSent(); },
    };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const client = { getOrders: async () => [paid], getOrder: async () => paid };
    const workflow = new PaidOrderWorkflow(client, ledger, new ConsoleEmailProvider(() => undefined), 'admin@example.invalid', notifications);
    const result = await workflow.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.adminNotifications.failed, 1);
    assert.equal(ledger.get(`telegram:paid-order:${paid.id}`)?.status, 'FAILED');
  } finally { ledger.close(); }
});

test('payment failure alerts are deduplicated without creating a paid-order or email event', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => { sends++; return { messageId: 'synthetic', simulated: true }; },
    };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    let emailSends = 0;
    const client = {
      getOrders: async () => [failedPayment],
      getOrder: async () => { throw new Error('must not fetch a failed payment as a paid order'); },
    };
    const workflow = new PaidOrderWorkflow(client, ledger, new ConsoleEmailProvider(() => { emailSends++; }),
      'admin@example.invalid', notifications);
    const first = await workflow.run();
    const second = await workflow.run();
    assert.equal(first.failed, 0);
    assert.equal(first.adminNotifications.delivered, 1);
    assert.equal(second.adminNotifications.skipped, 1);
    assert.equal(sends, 1);
    assert.equal(emailSends, 0);
  } finally { ledger.close(); }
});

test('a historical failed payment does not generate a false failure alert after payment succeeds', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const resolved = parseOrder({ ...failedPayment, status: 'paid', payment_status: 'SUCCESS',
      customer_email: 'fixture@example.invalid', customer_name: 'Fixture Customer' });
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => ({ messageId: 'synthetic', simulated: true }),
    };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const workflow = new PaidOrderWorkflow(
      { getOrders: async () => [resolved], getOrder: async () => resolved }, ledger,
      new ConsoleEmailProvider(() => undefined), 'admin@example.invalid', notifications,
    );
    const result = await workflow.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.adminNotifications.delivered, 1);
    assert.equal(ledger.get(`telegram:payment-failure:${resolved.id}`), null);
    assert.ok(ledger.get(`telegram:paid-order:${resolved.id}`));
  } finally { ledger.close(); }
});

test('referral side-effect success stays successful when Telegram delivery is unavailable', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => { throw new Error('synthetic ambiguous failure'); },
    };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const workflow = new ReferralQualificationWorkflow(
      { triggerReferralProcessing: async () => stats }, ledger, 60, () => Date.parse('2026-09-25T10:00:00Z'), notifications,
    );
    const first = await workflow.run();
    const second = await workflow.run();
    assert.equal(first.status, 'completed');
    assert.equal(first.sideEffectInvoked, true);
    assert.equal(first.adminNotificationStatus, 'PENDING');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.adminNotificationStatus, undefined);
  } finally { ledger.close(); }
});
