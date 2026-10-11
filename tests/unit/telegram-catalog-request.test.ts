import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProductCatalog } from '../../src/integrations/alveron/catalog.js';
import { parseProductRequestPage } from '../../src/integrations/alveron/product-requests.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import {
  lowStockNotification,
  productRequestNotification,
  renderTelegramHtml,
  telegramTestNotification,
  type AdminNotificationProvider,
} from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { ProductRequestNotificationWorkflow } from '../../src/workflows/product-request-notification.js';
import { LowStockNotificationWorkflow } from '../../src/workflows/low-stock-notification.js';

const service = (
  ledger: SqliteLedger,
  send: (notification: { resourceId: string }) => Promise<{ messageId: string; simulated: boolean }>,
) => {
  const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true, send };
  return new AdminNotificationService(ledger, provider, createLogger('silent'));
};

test('catalog parser reads the live response envelope and keeps only stock-relevant fields', () => {
  const page = parseProductCatalog({
    items: [{
      id: 'p1', title: 'Track Suit', track_inventory: true, low_stock_alert: 5,
      variants: [{ id: 'v1', stock: 2, color: 'white,black', size: 'xxl' }, { id: 'v2', stock: null }],
    }],
    total: 1,
  });
  assert.equal(page.products.length, 1);
  assert.equal(page.skipped, 0);
  const product = page.products[0]!;
  assert.equal(product.trackInventory, true);
  assert.equal(product.lowStockAlert, 5);
  assert.equal(product.variants[0]!.stock, 2);
  assert.equal(product.variants[0]!.color, 'white,black');
  assert.equal(product.variants[1]!.stock, null);
});

test('catalog parser fails closed on an unexpected envelope instead of reporting zero stock', () => {
  assert.throws(() => parseProductCatalog({ data: [] }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseProductCatalog([]), { code: 'INVALID_RESPONSE' });
});

test('catalog parser skips an unidentifiable product but still reports the rest', () => {
  const page = parseProductCatalog({
    items: [{ title: 'No id', variants: [] }, { id: 'p1', title: 'Fine', variants: [] }], total: 2,
  });
  assert.equal(page.products.length, 1);
  assert.equal(page.skipped, 1);
});

test('product request parser requires identity and omits absent customer data rather than guessing', () => {
  const page = parseProductRequestPage({
    items: [
      { id: 'req-1', reference: 'ARP-123456', customer_name: 'John Doe', phone: '08000000000',
        product_type: 'Shoes', size: '42', quantity: 1, description: 'Black leather shoe.' },
      { reference: 'ARP-999999' },
      { note: 'no identity at all' },
    ],
    total: 3,
  });
  assert.equal(page.requests.length, 2);
  assert.equal(page.skipped, 1);
  const full = page.requests[0]!;
  assert.equal(full.id, 'req-1');
  assert.equal(full.reference, 'ARP-123456');
  assert.equal(full.customerName, 'John Doe');
  // A row exposing only a reference still yields a usable, dedupable identity.
  assert.equal(page.requests[1]!.id, 'ARP-999999');
  assert.equal(page.requests[1]!.customerName, null);
});

test('product request notification omits missing fields and never carries an image URL', () => {
  const request = parseProductRequestPage({
    items: [{ id: 'req-1', reference: 'ARP-123456', customer_name: 'John <b>Doe</b> & Co',
      description: 'Black "leather" shoe', image_url: 'https://private.supabase.co/storage/v1/object/sign/x?token=secret' }],
    total: 1,
  }).requests[0]!;
  const rendered = renderTelegramHtml(productRequestNotification(request));
  assert.match(rendered, /ARP-123456/);
  assert.match(rendered, /John &lt;b&gt;Doe&lt;\/b&gt; &amp; Co/);
  assert.match(rendered, /Black &quot;|Black "leather"/);
  // The private signed URL must never reach Telegram.
  assert.doesNotMatch(rendered, /supabase|token=secret|image_url/);
  // Only fields the fixture actually provides are shown; the rest are omitted, not invented.
  assert.match(rendered, /<b>Customer<\/b>/);
  assert.doesNotMatch(rendered, /<b>Phone<\/b>|<b>Product Type<\/b>|<b>Size<\/b>|<b>Quantity<\/b>/);
});

test('product request alert is idempotent per request across repeated polls', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const client = {
      getProductRequests: async () => parseProductRequestPage({
        items: [{ id: 'req-1', reference: 'ARP-123456' }, { id: 'req-2', reference: 'ARP-123457' }], total: 2,
      }),
    };
    const workflow = new ProductRequestNotificationWorkflow(client, notifications);
    const first = await workflow.run();
    assert.equal(first.notified, 2);
    assert.equal(sends, 2);
    // A retried poll must not produce NEW ORDER-style duplicates.
    const second = await workflow.run();
    assert.equal(second.notified, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('a product-request read failure alerts nobody and reports no success', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const client = { getProductRequests: async () => { throw new Error('upstream down'); } };
    const result = await new ProductRequestNotificationWorkflow(client, notifications).run();
    assert.equal(result.status, 'failed');
    assert.equal(result.notified, 0);
    assert.equal(sends, 0);
  } finally { ledger.close(); }
});

test('Telegram failure does not fail the product-request poll', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => { throw new NotificationNotSent(); });
    const client = {
      getProductRequests: async () => parseProductRequestPage({ items: [{ id: 'req-1' }], total: 1 }),
    };
    const result = await new ProductRequestNotificationWorkflow(client, notifications).run();
    assert.equal(result.status, 'completed');
    assert.equal(result.notified, 0);
    assert.equal(result.results[0]!.status, 'failed');
  } finally { ledger.close(); }
});

test('product-request alerts are capped per run and the remainder is reported, not dropped silently', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: '1', simulated: false }));
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `req-${i}` }));
    const client = {
      getProductRequests: async (page: number, size: number) =>
        parseProductRequestPage({ items: items.slice((page - 1) * size, page * size), total: items.length }),
    };
    const result = await new ProductRequestNotificationWorkflow(client, notifications).run();
    assert.equal(result.notified, 25);
    // Paging stops once a page yields nothing new, so only page 2's surplus is reported.
    assert.equal(result.suppressedByCap, 25);
    assert.equal(result.pagesRead, 2);
  } finally { ledger.close(); }
});

test('low stock notification renders the variant and threshold and escapes the product title', () => {
  const rendered = renderTelegramHtml(lowStockNotification({
    variantId: 'v1', productTitle: 'Polo <script>', variantTitle: 'Black / M', stock: 2, lowStockAlert: 5,
  }));
  assert.match(rendered, /📦 LOW STOCK/);
  assert.match(rendered, /Polo &lt;script&gt;/);
  assert.match(rendered, /Black \/ M/);
  assert.match(rendered, /Remaining<\/b>\n2/);
  assert.doesNotMatch(rendered, /<script>/);
});

test('low stock alerts only for tracked products at or below the threshold', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const sent: string[] = [];
    const notifications = service(ledger, async (notification) => { sent.push(notification.resourceId); return { messageId: '1', simulated: false }; });
    const client = {
      getProductCatalog: async () => parseProductCatalog({
        items: [
          { id: 'p1', title: 'Tracked', track_inventory: true, low_stock_alert: 5,
            variants: [{ id: 'v-low', stock: 2, color: 'Black', size: 'M' }, { id: 'v-ok', stock: 9 }] },
          { id: 'p2', title: 'Untracked', track_inventory: false, low_stock_alert: 5,
            variants: [{ id: 'v-untracked', stock: 0 }] },
          { id: 'p3', title: 'No threshold', track_inventory: true, low_stock_alert: null,
            variants: [{ id: 'v-nothreshold', stock: 1 }] },
        ],
        total: 3,
      }),
    };
    const result = await new LowStockNotificationWorkflow(client, notifications).run();
    assert.equal(result.belowThreshold, 1);
    assert.deepEqual(sent, ['v-low']);
  } finally { ledger.close(); }
});

test('low stock is idempotent per variant and stock level, and re-alerts on a further drop', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let stock = 5;
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const client = {
      getProductCatalog: async () => parseProductCatalog({
        items: [{ id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 5,
          variants: [{ id: 'v1', stock, color: 'Black', size: 'M' }] }],
        total: 1,
      }),
    };
    const workflow = new LowStockNotificationWorkflow(client, notifications);
    assert.equal((await workflow.run()).notified, 1);
    // Same level again: no repeat alert.
    assert.equal((await workflow.run()).notified, 0);
    assert.equal((await workflow.run()).duplicates, 1);
    assert.equal(sends, 1);
    // A further drop to a new level is genuinely new information.
    stock = 1;
    assert.equal((await workflow.run()).notified, 1);
    assert.equal(sends, 2);
  } finally { ledger.close(); }
});

test('Telegram failure does not fail the low-stock scan', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => { throw new NotificationNotSent(); });
    const client = {
      getProductCatalog: async () => parseProductCatalog({
        items: [{ id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 5, variants: [{ id: 'v1', stock: 1 }] }],
        total: 1,
      }),
    };
    const result = await new LowStockNotificationWorkflow(client, notifications).run();
    assert.equal(result.status, 'completed');
    assert.equal(result.belowThreshold, 1);
    assert.equal(result.notified, 0);
  } finally { ledger.close(); }
});

test('the controlled test notification renders its unlabeled opening line', () => {
  // Regression: an empty field label previously tripped label validation and made the test
  // alert throw VALIDATION_FAILED, so the real controlled test could never send.
  const rendered = renderTelegramHtml(telegramTestNotification('production', 'fixture-event'));
  assert.match(rendered, /🧪 ALVERON TELEGRAM TEST/);
  assert.match(rendered, /Telegram admin notifications are configured successfully\./);
  assert.match(rendered, /<b>Environment<\/b>\nproduction/);
  assert.match(rendered, /<b>Gateway<\/b>\nConnected/);
  assert.match(rendered, /<b>n8n<\/b>\nConnected/);
});

test('a disabled notifier turns both new workflows into a no-op and never reports a failure', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const disabled = { async notify() { return { status: 'DISABLED' as const }; } };
    const client = {
      getProductRequests: async () => parseProductRequestPage({ items: [{ id: 'req-1' }], total: 1 }),
      getProductCatalog: async () => parseProductCatalog({
        items: [{ id: 'p1', title: 'Polo', track_inventory: true, low_stock_alert: 5, variants: [{ id: 'v1', stock: 1 }] }],
        total: 1,
      }),
    };
    const requests = await new ProductRequestNotificationWorkflow(client, disabled).run();
    const stock = await new LowStockNotificationWorkflow(client, disabled).run();
    // An unconfigured admin channel is not a delivery failure, and the run still succeeds.
    assert.equal(requests.status, 'completed');
    assert.equal(stock.status, 'completed');
    assert.equal(requests.notified, 0);
    assert.equal(stock.notified, 0);
    assert.equal(requests.results[0]!.status, 'skipped');
    assert.equal(stock.results[0]!.status, 'skipped');
    // Detection itself still happened, so enabling the channel later needs no backfill.
    assert.equal(stock.belowThreshold, 1);
  } finally { ledger.close(); }
});
