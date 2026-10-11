import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import {
  EmailDeliveryAmbiguous, EmailNotSent, NotificationNotSent, ResendEmailProvider,
} from '../../src/providers/email/index.js';
import { NotificationRunner } from '../../src/workflows/notification-runner.js';
import { PaidOrderWorkflow } from '../../src/workflows/paid-order-confirmation.js';

const config = { apiKey: 're_synthetic_not_a_real_key', fromEmail: 'orders@example.invalid', fromName: 'Alveron Fashion', timeoutMs: 5000 };
const message = { recipient: 'customer@example.invalid', subject: 'Order #1042 confirmation', text: 'Hello <Customer>\nOrder #1042' };
const orderId = '00000000-0000-4000-8000-000000000001';
const order = parseOrder({
  id: orderId, order_number: 1042, status: 'paid', payment_status: 'SUCCESS',
  customer_email: 'customer@example.invalid', customer_name: 'Fixture Customer', total: 85000,
  subtotal: 85000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Synthetic <item>', variant_title: 'M', quantity: 2, price: 42500 }], payments: [],
});

const noSleep = async () => undefined;
const provider = (handler: typeof fetch, extra: Partial<typeof config> = {}, maxRetries = 2) =>
  new ResendEmailProvider({ ...config, ...extra }, handler, noSleep, maxRetries);

test('Resend success posts a branded, escaped message and returns the provider id', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = provider(async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return Response.json({ id: 'em_123' }); });
  const receipt = await send.sendCustomerOrderConfirmation(message, 'key');
  assert.deepEqual(receipt, { messageId: 'resend:em_123', simulated: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], `Bearer ${config.apiKey}`);
  const body = JSON.parse(String(calls[0]!.init.body)) as { from: string; to: string[]; subject: string; html: string };
  assert.equal(body.from, 'Alveron Fashion <orders@example.invalid>');
  assert.deepEqual(body.to, ['customer@example.invalid']);
  assert.equal(body.html.includes('&lt;Customer&gt;'), true);
  assert.equal(body.html.includes('<Customer>'), false);
  assert.equal(body.html.includes('<item>'), false);
  assert.equal(JSON.stringify(receipt).includes(config.apiKey), false);
});

test('Resend customer transactional email carries the stable template and a plain-text fallback', async () => {
  const calls: RequestInit[] = [];
  const send = provider(async (_url, init) => { calls.push(init ?? {}); return Response.json({ id: 'em_tx' }); });
  const receipt = await send.sendCustomerTransactional({
    template: 'order_shipped', recipient: 'customer@example.invalid',
    subject: 'Your order has shipped — order #1042', text: 'Your order is on its way.', referenceId: orderId,
  }, 'key');
  assert.deepEqual(receipt, { messageId: 'resend:em_tx', simulated: false });
  const body = JSON.parse(String(calls[0]!.body)) as { text: string; html: string; subject: string };
  assert.equal(body.text, 'Your order is on its way.');
  assert.match(body.html, /Your order has shipped/);
  assert.equal(JSON.stringify(receipt).includes(config.apiKey), false);
});

test('Resend transient failure is retried then reported as a retryable non-delivery', async () => {
  let calls = 0;
  const send = provider(async () => { calls++; return Response.json({ message: 'busy' }, { status: 503 }); }, {}, 1);
  await assert.rejects(send.sendCustomerOrderConfirmation(message, 'key'), (error: unknown) => {
    assert.ok(error instanceof EmailNotSent && error instanceof NotificationNotSent);
    assert.equal((error as EmailNotSent).failure, 'retryable');
    assert.equal((error as EmailNotSent).httpStatus, 503);
    return true;
  });
  assert.equal(calls, 2, 'one attempt plus one bounded retry');
});

test('Resend permanent failure is not retried and is reported as permanent', async () => {
  let calls = 0;
  const send = provider(async () => { calls++; return Response.json({ message: 'invalid from' }, { status: 422 }); });
  await assert.rejects(send.sendAdminOrderAlert(message, 'key'), (error: unknown) => {
    assert.equal((error as EmailNotSent).failure, 'permanent');
    return true;
  });
  assert.equal(calls, 1);
});

test('missing API key fails closed without touching the network', async () => {
  let calls = 0;
  const send = provider(async () => { calls++; return Response.json({ id: 'x' }); }, { apiKey: '' });
  await assert.rejects(send.sendCustomerOrderConfirmation(message, 'key'), (error: unknown) => {
    assert.equal((error as EmailNotSent).failure, 'permanent');
    return true;
  });
  assert.equal(calls, 0);
});

test('missing sender configuration fails closed without touching the network', async () => {
  let calls = 0;
  const send = provider(async () => { calls++; return Response.json({ id: 'x' }); }, { fromEmail: 'not-an-email' });
  await assert.rejects(send.sendCustomerOrderConfirmation(message, 'key'), { name: 'EmailNotSent' });
  assert.equal(calls, 0);
});

test('a malformed 2xx provider response is ambiguous, never a confirmed send', async () => {
  const send = provider(async () => Response.json({ unexpected: true }));
  await assert.rejects(send.sendCustomerOrderConfirmation(message, 'key'), (error: unknown) => {
    assert.ok(error instanceof EmailDeliveryAmbiguous);
    return true;
  });
});

test('a transport failure is ambiguous so the ledger records PENDING, not FAILED', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const send = provider(async () => { throw new TypeError('fetch failed'); });
    const runner = new NotificationRunner(ledger, send.namespace);
    assert.deepEqual(await runner.run(orderId, 'customer', key => send.sendCustomerOrderConfirmation(message, key)),
      { status: 'PENDING', reason: 'DELIVERY_RECONCILIATION_REQUIRED', category: 'UNKNOWN_ERROR' });
    assert.equal(ledger.get(`${send.namespace}:paid-order-confirmation:${orderId}:customer`)?.status, 'PENDING');
  } finally { ledger.close(); }
});

test('customer and admin paid-order emails are sent once and suppressed on repeat', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const sends: { to: string[]; subject: string }[] = [];
    const send = provider(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
      sends.push({ to: body.to, subject: body.subject });
      return Response.json({ id: `em_${sends.length}` });
    });
    const client = { getOrders: async () => [order], getOrder: async () => order };
    const workflow = new PaidOrderWorkflow(client, ledger, send, 'admin@example.invalid');
    const first = await workflow.run();
    assert.equal(first.processed, 1);
    assert.equal(first.failed, 0);
    assert.equal(sends.length, 2);
    assert.deepEqual(sends.map(s => s.to[0]).sort(), ['admin@example.invalid', 'customer@example.invalid']);
    assert.ok(sends.some(s => s.subject === 'Order #1042 confirmation'));
    assert.ok(sends.some(s => s.subject === 'Paid order #1042'));
    const second = await workflow.run();
    assert.equal(second.processed, 0);
    assert.equal(second.skipped, 1);
    assert.equal(sends.length, 2, 'successful sends permanently suppress duplicates');
  } finally { ledger.close(); }
});

test('concurrent email sends cannot both deliver', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let calls = 0;
    const send = provider(async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return Response.json({ id: 'em_once' }); });
    const runner = new NotificationRunner(ledger, send.namespace);
    const results = await Promise.all([
      runner.run(orderId, 'customer', key => send.sendCustomerOrderConfirmation(message, key)),
      runner.run(orderId, 'customer', key => send.sendCustomerOrderConfirmation(message, key)),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map(result => result.status).sort(), ['SKIPPED', 'SUCCESS']);
  } finally { ledger.close(); }
});

test('an email failure is isolated from the rest of the paid-order run', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const send = provider(async () => Response.json({ message: 'bad' }, { status: 422 }));
    const client = { getOrders: async () => [order], getOrder: async () => order };
    const workflow = new PaidOrderWorkflow(client, ledger, send, 'admin@example.invalid');
    const result = await workflow.run();
    assert.equal(result.failed, 1);
    assert.equal(result.results[0]?.reason, 'NOTIFICATION_NOT_SENT');
    assert.equal(result.status, 'partial_failure');
  } finally { ledger.close(); }
});
