import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import {
  disabledAdminNotifier, paidOrderNotification, renderTelegramHtml,
} from '../../src/providers/admin/index.js';
import { PaidOrderWorkflow } from '../../src/workflows/paid-order-confirmation.js';
import type { EmailProvider } from '../../src/providers/email/index.js';

const paidShipping = parseOrder({
  id: '00000000-0000-4000-8000-000000000010', order_number: 1042, status: 'paid', payment_status: 'SUCCESS',
  customer_email: 'fixture@example.invalid', customer_name: 'Fixture Customer',
  subtotal: 80000, discount: 5000, shipping: 2000, total: 77000, currency: 'NGN',
  fulfillment: 'shipping',
  shipping_address: { full_name: 'Fixture Customer', phone: '08000000000', street: '12 Test Street',
    city: 'Owerri', state: 'Imo', country: 'Nigeria' },
  items: [{ title: 'Ankara Dress', variant_title: null, variant_size: 'M', variant_color: 'Blue',
    quantity: 2, price: 40000 }],
  payments: [],
});

const paidPickup = parseOrder({
  id: '00000000-0000-4000-8000-000000000011', order_number: 1043, status: 'paid', payment_status: 'SUCCESS',
  customer_email: 'fixture@example.invalid', customer_name: null,
  subtotal: 30000, discount: 0, shipping: 0, total: 30000, currency: 'NGN',
  fulfillment: 'pickup', pickup_location: 'location-1',
  pickup_location_snapshot: { name: 'Alveron Office', address: '4 Office Road', city: 'Owerri', state: 'Imo' },
  items: [{ title: 'Leather Bag', variant_title: 'One Size', variant_size: null, variant_color: null,
    quantity: 1, price: 30000 }],
  payments: [],
});

const unconfiguredEmail: EmailProvider = {
  namespace: 'unknown',
  sendCustomerOrderConfirmation: async () => { throw new NotificationNotSent('CONFIGURATION_ERROR'); },
  sendAdminOrderAlert: async () => { throw new NotificationNotSent('CONFIGURATION_ERROR'); },
  sendCustomerTransactional: async () => { throw new NotificationNotSent('CONFIGURATION_ERROR'); },
};
const passEmail = (namespace: string): EmailProvider => ({
  namespace,
  sendCustomerOrderConfirmation: async () => ({ messageId: 'synthetic', simulated: true }),
  sendAdminOrderAlert: async () => ({ messageId: 'synthetic', simulated: true }),
  sendCustomerTransactional: async () => ({ messageId: 'synthetic', simulated: true }),
});

test('paid-order Telegram alert lists products, variants, amounts and the delivery address', () => {
  const html = renderTelegramHtml(paidOrderNotification(paidShipping));
  assert.match(html, /NEW PAID ORDER/);
  assert.match(html, /#1042/);
  assert.match(html, /Ankara Dress/);
  assert.match(html, /M · Blue/);
  assert.match(html, /× 2/);
  assert.match(html, /Subtotal/);
  assert.match(html, /₦80,000/);
  assert.match(html, /-₦5,000/);
  assert.match(html, /₦77,000/);
  assert.match(html, /Delivery/);
  assert.match(html, /12 Test Street, Owerri, Imo, Nigeria/);
});

test('paid-order Telegram alert renders a pickup destination when there is no shipping address', () => {
  const html = renderTelegramHtml(paidOrderNotification(paidPickup));
  assert.match(html, /Pickup/);
  assert.match(html, /Alveron Office/);
  assert.match(html, /Free/);
  assert.equal(html.includes('Delivery —'), false);
  assert.equal(html.includes('Pickup — Alveron Office'), true);
});

test('an unconfigured notification channel is classified as a configuration error, not an unknown one', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const workflow = new PaidOrderWorkflow(
      { getOrders: async () => [paidShipping], getOrder: async () => paidShipping },
      ledger, unconfiguredEmail, 'admin@example.invalid', disabledAdminNotifier);
    const result = await workflow.run();
    assert.equal(result.status, 'partial_failure');
    assert.equal(result.failed, 1);
    assert.equal(result.failureCategory, 'CONFIGURATION_ERROR');
    assert.equal(result.results[0]?.reason, 'NOTIFICATION_NOT_SENT');
    assert.equal(result.results[0]?.category, 'CONFIGURATION_ERROR');
  } finally { ledger.close(); }
});

test('an unclassified notification failure still yields a bounded category instead of UNKNOWN_ERROR', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const plainFailure: EmailProvider = {
      ...unconfiguredEmail,
      sendCustomerOrderConfirmation: async () => { throw new NotificationNotSent(); },
    };
    const workflow = new PaidOrderWorkflow(
      { getOrders: async () => [paidPickup], getOrder: async () => paidPickup },
      ledger, plainFailure, 'admin@example.invalid', disabledAdminNotifier);
    const result = await workflow.run();
    assert.equal(result.status, 'partial_failure');
    assert.equal(result.failureCategory, 'INVALID_RESPONSE');
  } finally { ledger.close(); }
});

test('an exhausted failed notification keeps its real category instead of a ledger error', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const workflow = new PaidOrderWorkflow(
      { getOrders: async () => [paidShipping], getOrder: async () => paidShipping },
      ledger, unconfiguredEmail, 'admin@example.invalid', disabledAdminNotifier);
    // Burn the three attempts so the next claim is refused and the record is retry-capped.
    for (let attempt = 0; attempt < 3; attempt++) await workflow.run();
    const result = await workflow.run();
    assert.equal(result.status, 'partial_failure');
    assert.equal(result.failureCategory, 'CONFIGURATION_ERROR');
    assert.equal(result.results[0]?.reason, 'NOTIFICATION_NOT_SENT');
    assert.equal(result.results[0]?.category, 'CONFIGURATION_ERROR');
    assert.notEqual(result.results[0]?.reason, 'DELIVERY_RECONCILIATION_REQUIRED');
  } finally { ledger.close(); }
});

test('a pre-category FAILED claim is re-armed once and can persist its real category', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alveron-ledger-'));
  const path = join(dir, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE notification_ledger (
      key TEXT PRIMARY KEY, order_id TEXT NOT NULL, event_type TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT NOT NULL, attempts INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT, provider_message_id TEXT
    );`);
    legacy.prepare('INSERT INTO notification_ledger VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'unknown:paid-order-confirmation:x:customer', 'x', 'paid-order-confirmation:customer',
      'FAILED', 'legacy-owner', 3, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'NOTIFICATION_NOT_SENT', null);
    legacy.close();

    const ledger = new SqliteLedger(path);
    try {
      assert.equal(ledger.get('unknown:paid-order-confirmation:x:customer')?.last_category, null);
      const claim = ledger.claim('unknown:paid-order-confirmation:x:customer', 'x', 'paid-order-confirmation:customer');
      assert.ok(claim, 'the retry-capped legacy row is claimable after the one-time re-arm');
      ledger.markFailure(claim, 'NOTIFICATION_NOT_SENT', 'CONFIGURATION_ERROR');
      assert.equal(ledger.get('unknown:paid-order-confirmation:x:customer')?.last_category, 'CONFIGURATION_ERROR');
    } finally { ledger.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a successful paid-order run carries no failure category', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const workflow = new PaidOrderWorkflow(
      { getOrders: async () => [paidPickup], getOrder: async () => paidPickup },
      ledger, passEmail('development-console'), 'admin@example.invalid', disabledAdminNotifier);
    const result = await workflow.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.failed, 0);
    assert.equal(result.failureCategory, undefined);
  } finally { ledger.close(); }
});
