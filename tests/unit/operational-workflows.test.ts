import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderClient } from '../../src/integrations/alveron/client.js';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { parseProductCatalog } from '../../src/integrations/alveron/catalog.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { ConsoleEmailProvider } from '../../src/providers/email/index.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import {
  renderTelegramHtml,
  outOfStockNotification,
  type AdminNotificationProvider,
} from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { OrderOperationsWorkflow } from '../../src/workflows/order-operations.js';
import { PaymentReconciliationWorkflow, detectFindings } from '../../src/workflows/payment-reconciliation.js';
import { ShippingSlaWorkflow } from '../../src/workflows/shipping-sla.js';
import { SystemHealthWorkflow } from '../../src/workflows/system-health.js';
import { LowStockNotificationWorkflow } from '../../src/workflows/low-stock-notification.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const orderClient = (getOrders: OrderClient['getOrders']): OrderClient => ({
  getOrders, getOrder: async () => { throw new Error('getOrder is not used by these workflows'); },
});

const service = (
  ledger: SqliteLedger,
  send: (notification: { resourceId: string; eventKey: string }) => Promise<{ messageId: string; simulated: boolean }>,
) => {
  const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true, send };
  return new AdminNotificationService(ledger, provider, createLogger('silent'));
};

const order = (over: Record<string, unknown> = {}) => parseOrder({
  id: ID(1), order_number: 1001, status: 'processing', payment_status: 'SUCCESS',
  customer_email: 'fixture@example.invalid', customer_name: 'Fixture', total: 100000,
  subtotal: 100000, shipping: 0, discount: 0, currency: 'NGN',
  created_at: '2026-01-01T00:00:00.000Z', payment_date: '2026-01-01T00:00:00.000Z',
  items: [{ title: 'Synthetic', variant_title: null, quantity: 1, price: 100000 }],
  payments: [], ...over,
});

test('order operations notify on operational statuses only and are idempotent per order+status', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const paid = order({ id: ID(1), status: 'paid', payment_status: 'SUCCESS' });
    const shipped = order({ id: ID(2), status: 'shipped', payment_status: 'SUCCESS' });
    const done = order({ id: ID(3), status: 'delivered', payment_status: 'SUCCESS' });
    const workflow = new OrderOperationsWorkflow(orderClient(async () => [paid, shipped, done]), notifications);
    const first = await workflow.run();
    // `paid` is owned by the paid-order workflow and must not double-alert here.
    assert.equal(first.eligible, 2);
    assert.equal(first.notified, 2);
    assert.equal(sends, 2);
    const second = await workflow.run();
    assert.equal(second.notified, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('order operations never mutate Alveron and survive a read failure without alerting', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const result = await new OrderOperationsWorkflow(
      orderClient(async () => { throw new Error('upstream down'); }), notifications,
    ).run();
    assert.equal(result.status, 'failed');
    assert.equal(sends, 0);
  } finally { ledger.close(); }
});

test('reconciliation finds only provable anomalies and never edits payment state', () => {
  const duplicate = detectFindings(order({
    status: 'paid', payment_status: 'SUCCESS',
    payments: [
      { id: ID(9), order_id: ID(1), provider_reference: 'ref-a', status: 'SUCCESS', amount: 10000000, currency: 'NGN' },
      { id: ID(8), order_id: ID(1), provider_reference: 'ref-b', status: 'SUCCESS', amount: 10000000, currency: 'NGN' },
    ],
  }));
  assert.deepEqual(duplicate.map(f => f.code).sort(), ['DUPLICATE_PAYMENT']);

  const notConfirmed = detectFindings(order({
    status: 'pending', payment_status: 'PENDING',
    payments: [{ id: ID(7), order_id: ID(1), provider_reference: 'ref', status: 'SUCCESS', amount: 10000000, currency: 'NGN' }],
  }));
  assert.deepEqual(notConfirmed.map(f => f.code), ['PROVIDER_PAID_NOT_CONFIRMED']);

  const mismatch = detectFindings(order({ status: 'paid', payment_status: 'SUCCESS',
    payments: [{ id: ID(6), order_id: ID(1), provider_reference: 'ref', status: 'SUCCESS', amount: 5, currency: 'NGN' }] }));
  assert.deepEqual(mismatch.map(f => f.code), ['AMOUNT_MISMATCH']);

  const clean = detectFindings(order({ status: 'paid', payment_status: 'SUCCESS',
    payments: [{ id: ID(5), order_id: ID(1), provider_reference: 'ref', status: 'SUCCESS', amount: 10000000, currency: 'NGN' }] }));
  assert.deepEqual(clean, []);
});

test('reconciliation is idempotent for a persistent anomaly', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const target = order({ status: 'pending', payment_status: 'VERIFICATION_FAILED', payments: [] });
    const workflow = new PaymentReconciliationWorkflow(orderClient(async () => [target]), notifications);
    assert.equal((await workflow.run()).notified, 1);
    const second = await workflow.run();
    assert.equal(second.notified, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(sends, 1);
  } finally { ledger.close(); }
});

test('shipping SLA alerts on paid orders past the window and deduplicates the backlog', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const old = order({ id: ID(1), status: 'processing', created_at: '2026-01-01T00:00:00.000Z' });
    const fresh = order({ id: ID(2), status: 'processing',
      created_at: '2026-01-09T23:00:00.000Z', payment_date: '2026-01-09T23:00:00.000Z' });
    const shipped = order({ id: ID(3), status: 'shipped', created_at: '2026-01-01T00:00:00.000Z' });
    const unpaid = order({ id: ID(4), status: 'processing', payment_status: 'pending', created_at: '2026-01-01T00:00:00.000Z' });
    const workflow = new ShippingSlaWorkflow(orderClient(async () => [old, fresh, shipped, unpaid]), 48, notifications, () => now);
    const first = await workflow.run();
    assert.equal(first.waiting, 1);
    assert.equal(first.notified, 1);
    assert.equal(first.oldestAgeHours, 216);
    assert.equal((await workflow.run()).duplicates, 1);
    assert.equal(sends, 1);
  } finally { ledger.close(); }
});

test('shipping SLA skips orders whose age cannot be proven rather than guessing', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: '1', simulated: false }));
    const noDates = parseOrder({ id: ID(1), order_number: 1, status: 'processing', payment_status: 'SUCCESS',
      customer_email: null, customer_name: null, total: 1, subtotal: 1, shipping: 0, discount: 0, currency: 'NGN',
      items: [{ title: 'x', variant_title: null, quantity: 1, price: 1 }], payments: [] });
    const result = await new ShippingSlaWorkflow(orderClient(async () => [noDates]), 48, notifications,
      () => Date.parse('2026-01-10T00:00:00.000Z')).run();
    assert.equal(result.waiting, 0);
    assert.equal(result.unknownAge, 1);
    assert.equal(result.notified, 0);
  } finally { ledger.close(); }
});

test('system health reports only observable components and flags a failed Alveron probe', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: '1', simulated: false }));
    const healthy = await new SystemHealthWorkflow(
      { getProductCatalog: async () => parseProductCatalog({ items: [], total: 0 }) }, true, notifications, 'production',
    ).run();
    assert.equal(healthy.degraded, false);
    assert.deepEqual(healthy.components.map(c => c.name), ['n8n', 'Gateway', 'Alveron API', 'Telegram']);
    assert.ok(healthy.components.every(c => c.ok));

    const degraded = await new SystemHealthWorkflow(
      { getProductCatalog: async () => { throw new Error('down'); } }, true, notifications, 'production',
    ).run();
    assert.equal(degraded.degraded, true);
    assert.equal(degraded.components.find(c => c.name === 'Alveron API')?.ok, false);
  } finally { ledger.close(); }
});

test('out-of-stock is a distinct alert and a drop from low to zero re-alerts', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const kinds: string[] = [];
    const notifications = service(ledger, async (notification) => { kinds.push(notification.eventKey); return { messageId: '1', simulated: false }; });
    let stock = 2;
    const client = {
      getProductCatalog: async () => parseProductCatalog({
        items: [{ id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 5,
          variants: [{ id: 'v1', stock, color: 'Black', size: 'M' }] }], total: 1,
      }),
    };
    const workflow = new LowStockNotificationWorkflow(client, notifications);
    const low = await workflow.run();
    assert.equal(low.notified, 1);
    assert.equal(low.outOfStock, 0);
    stock = 0;
    const out = await workflow.run();
    assert.equal(out.outOfStock, 1);
    assert.equal(out.notified, 1);
    assert.deepEqual(kinds, ['low-stock:v1:2', 'out-of-stock:v1:0']);
    const rendered = renderTelegramHtml(outOfStockNotification({ variantId: 'v1', productTitle: 'Polo', variantTitle: 'Black / M' }));
    assert.match(rendered, /📦 OUT OF STOCK/);
  } finally { ledger.close(); }
});

test('order operations also send the customer lifecycle email, idempotently', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: 'admin', simulated: false }));
    const lines: string[] = [];
    const email = new ConsoleEmailProvider(line => lines.push(line));
    const orderClient = {
      getOrders: async () => [order({ id: ID(1), status: 'shipped' })],
      getOrder: async () => { throw new Error('unused'); },
    };
    const workflow = new OrderOperationsWorkflow(orderClient, notifications, { emailProvider: email, ledger });
    const first = await workflow.run();
    assert.equal(first.notified, 1);
    assert.equal(first.customerEmails, 1);
    assert.ok(lines.some(line => line.includes('customer_transactional:order_shipped')));
    const second = await workflow.run();
    assert.equal(second.customerEmails, 0);
    assert.equal(second.customerEmailDuplicates, 1);
  } finally { ledger.close(); }
});

test('a customer email failure does not fail the admin order-status alert', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: 'admin', simulated: false }));
    const failingEmail = {
      namespace: 'test-email',
      sendCustomerOrderConfirmation: async () => { throw new NotificationNotSent(); },
      sendAdminOrderAlert: async () => { throw new NotificationNotSent(); },
      sendCustomerTransactional: async () => { throw new NotificationNotSent(); },
    };
    const workflow = new OrderOperationsWorkflow(
      orderClient(async () => [order({ id: ID(2), status: 'delivered' })]), notifications,
      { emailProvider: failingEmail, ledger },
    );
    const result = await workflow.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.notified, 1);
    assert.equal(result.customerEmailFailures, 1);
  } finally { ledger.close(); }
});

test('restock is detected only on the observed zero-to-positive transition', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const eventKeys: string[] = [];
    const notifications = service(ledger, async (notification) => {
      eventKeys.push(notification.eventKey); return { messageId: '1', simulated: false };
    });
    let stock = 0;
    const client = {
      getProductCatalog: async () => parseProductCatalog({
        items: [{ id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 3,
          variants: [{ id: 'v1', stock, color: 'Black', size: 'M' }] }], total: 1,
      }),
    };
    const workflow = new LowStockNotificationWorkflow(client, notifications, { ledger });
    assert.equal((await workflow.run()).restocked, 0);
    stock = 5;
    const restocked = await workflow.run();
    assert.equal(restocked.restocked, 1);
    assert.ok(eventKeys.includes('restock:v1:5'));
    stock = 0;
    await workflow.run();
    stock = 7;
    const again = await workflow.run();
    assert.equal(again.restocked, 1, 'a second restock to a new level alerts');
  } finally { ledger.close(); }
});

test('a Telegram failure never fails the operational polls', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => { throw new NotificationNotSent(); });
    const current = order({ status: 'processing' });
    const ops = await new OrderOperationsWorkflow(orderClient(async () => [current]), notifications).run();
    assert.equal(ops.status, 'completed');
    assert.equal(ops.notified, 0);
  } finally { ledger.close(); }
});
