import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProductCatalog } from '../../src/integrations/alveron/catalog.js';
import { parseProductRequestPage } from '../../src/integrations/alveron/product-requests.js';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import type { AdminNotificationProvider } from '../../src/providers/admin/index.js';
import { DailyOperationsSummaryWorkflow } from '../../src/workflows/daily-operations-summary.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const order = (n: number, status: string, payment: string) => parseOrder({
  id: ID(n), order_number: n, status, payment_status: payment,
  customer_email: 'fixture@example.invalid', customer_name: 'Fixture', total: 1000, subtotal: 1000,
  shipping: 0, discount: 0, currency: 'NGN', items: [{ title: 'x', variant_title: null, quantity: 1, price: 1000 }], payments: [],
});
const fixedNow = () => Date.parse('2026-02-03T12:00:00Z');

test('the daily operations summary counts Alveron reads and sends once per business day', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const sent: string[] = [];
    const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true,
      send: async (notification) => { sent.push(notification.eventKey); return { messageId: '1', simulated: false }; } };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const client = {
      getOrders: async () => [
        order(1, 'processing', 'SUCCESS'), order(2, 'shipped', 'SUCCESS'), order(3, 'pending', 'PENDING'),
        order(4, 'cancelled', 'pending'), order(5, 'ready_for_pickup', 'SUCCESS'),
      ],
      getProductCatalog: async () => parseProductCatalog({ items: [
        { id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 3,
          variants: [{ id: 'v1', stock: 0 }, { id: 'v2', stock: 2 }, { id: 'v3', stock: 9 }] },
      ], total: 1 }),
      getProductRequests: async () => parseProductRequestPage({ items: [
        { id: ID(20), status: 'pending' }, { id: ID(21), status: 'searching' }, { id: ID(22), status: 'quoted' },
      ], total: 3 }),
    };
    const workflow = new DailyOperationsSummaryWorkflow(client, notifications, 'UTC', fixedNow);
    const first = await workflow.run();
    assert.equal(first.status, 'completed');
    assert.equal(first.counts.paidOrders, 3);
    assert.equal(first.counts.pendingOrders, 1);
    assert.equal(first.counts.cancelledOrders, 1);
    assert.equal(first.counts.processing, 1);
    assert.equal(first.counts.shipped, 1);
    assert.equal(first.counts.awaitingPickup, 1);
    assert.equal(first.counts.outOfStock, 1);
    assert.equal(first.counts.lowStock, 1);
    assert.equal(first.counts.newRequests, 1);
    assert.equal(first.counts.awaitingQuote, 1);
    assert.equal(first.notificationStatus, 'SUCCESS');
    const second = await workflow.run();
    assert.equal(second.notificationStatus, 'SKIPPED', 'the same business day is suppressed');
    assert.equal(sent.length, 1);
  } finally { ledger.close(); }
});

test('a partial Alveron outage still sends the summary, flagged degraded and never guessed', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true,
      send: async () => ({ messageId: '1', simulated: false }) };
    const notifications = new AdminNotificationService(ledger, provider, createLogger('silent'));
    const client = {
      getOrders: async () => { throw new Error('upstream down'); },
      getProductCatalog: async () => parseProductCatalog({ items: [], total: 0 }),
      getProductRequests: async () => parseProductRequestPage({ items: [], total: 0 }),
    };
    const result = await new DailyOperationsSummaryWorkflow(client, notifications, 'UTC', fixedNow).run();
    assert.equal(result.status, 'completed');
    assert.equal(result.alveronHealthy, false);
    assert.equal(result.counts.paidOrders, 0);
  } finally { ledger.close(); }
});
