import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinanceEventClient } from '../../src/integrations/alveron/client.js';
import {
  parseFinanceEventPage, parseFinanceEventAck, ownerLedgerIdFromIdempotencyKey, type FinanceEvent,
} from '../../src/integrations/alveron/finance.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { renderTelegramHtml, type AdminNotification, type AdminNotificationProvider } from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import {
  FinanceEventsConsumerWorkflow, financeEventNotification,
} from '../../src/workflows/finance-events-consumer.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const event = (over: Partial<FinanceEvent> & { id: string; eventType: string }): FinanceEvent => ({
  payload: {}, status: 'pending', idempotencyKey: null, createdAt: '2026-10-04T09:00:00.000Z',
  deliveredAt: null, reviewStatus: null, ...over,
});

const page = (items: FinanceEvent[]) => parseFinanceEventPage({
  items: items.map(e => ({
    id: e.id, event_type: e.eventType, payload: e.payload, status: e.status,
    idempotency_key: e.idempotencyKey, created_at: e.createdAt, delivered_at: e.deliveredAt,
    review_status: e.reviewStatus,
  })),
  total: items.length, page: 1, pageSize: 50, pages: 1,
});

const service = (
  ledger: SqliteLedger,
  send: (notification: AdminNotification) => Promise<{ messageId: string; simulated: boolean }>,
) => {
  const provider: AdminNotificationProvider = { namespace: 'telegram', enabled: true, send };
  return new AdminNotificationService(ledger, provider, createLogger('silent'));
};

/** A FinanceEventClient that records acks and optionally throws on ack. */
const eventClient = (items: FinanceEvent[], opts: { ackFails?: boolean } = {}) => {
  const acked: string[] = [];
  const client: FinanceEventClient = {
    listFinanceEvents: async () => page(items),
    ackFinanceEvent: async (id: string) => {
      if (opts.ackFails) throw new Error('ack failed');
      acked.push(id);
      return { id, status: 'delivered' };
    },
  };
  return { client, acked };
};

test('the outbox parser is strict: a malformed page or event fails closed', () => {
  const good = parseFinanceEventPage({ items: [{ id: uuid(1), event_type: 'refund_recorded', payload: {},
    status: 'pending', created_at: '2026-10-04T09:00:00.000Z' }], total: 1, page: 1, pageSize: 50, pages: 1 });
  assert.equal(good.items[0]!.eventType, 'refund_recorded');
  assert.equal(good.items[0]!.idempotencyKey, null);
  // Missing array, bad status, non-uuid id, missing pagination all fail whole.
  assert.throws(() => parseFinanceEventPage({ total: 0, page: 1, pageSize: 50, pages: 0 }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceEventPage({ items: [{ id: uuid(1), event_type: 'x', status: 'weird', created_at: '2026-10-04T09:00:00.000Z' }], page: 1, pageSize: 50, pages: 1 }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceEventPage({ items: [{ id: 'not-a-uuid', event_type: 'x', status: 'pending', created_at: '2026-10-04T09:00:00.000Z' }], page: 1, pageSize: 50, pages: 1 }), /INVALID_RESPONSE/);
  assert.throws(() => parseFinanceEventPage({ items: [], page: 1, pageSize: 0, pages: 0 }), /INVALID_RESPONSE/);
  // An ack receipt must actually report delivered.
  assert.deepEqual(parseFinanceEventAck({ id: uuid(1), status: 'delivered' }), { id: uuid(1), status: 'delivered' });
  assert.throws(() => parseFinanceEventAck({ id: uuid(1), status: 'pending' }), /INVALID_RESPONSE/);
});

test('owner ledger ids are read from the authoritative idempotency key, never timestamps', () => {
  assert.equal(ownerLedgerIdFromIdempotencyKey(`owner_tx:${uuid(3)}`), uuid(3).toLowerCase());
  assert.equal(ownerLedgerIdFromIdempotencyKey(`opening_capital:${uuid(4)}`), uuid(4).toLowerCase());
  assert.equal(ownerLedgerIdFromIdempotencyKey('owner_tx:2026-10-04T09:00:00Z'), null);
  assert.equal(ownerLedgerIdFromIdempotencyKey(null), null);
});

test('owner withdrawal and capital events render the required Telegram messages', () => {
  const ledgerId = uuid(7);
  const withdrawal = financeEventNotification(event({
    id: uuid(1), eventType: 'owner_transaction_recorded',
    idempotencyKey: `owner_tx:${ledgerId}`,
    payload: { type: 'owner_draw', amountMinor: 15000000 },
  }));
  assert.ok(withdrawal);
  const withdrawalHtml = renderTelegramHtml(withdrawal!);
  assert.match(withdrawalHtml, /ALVERON OWNER WITHDRAWAL/);
  // 15,000,000 minor units = ₦150,000 — verbatim, not recalculated.
  assert.match(withdrawalHtml, /₦150,000/);
  assert.match(withdrawalHtml, /equity movements, not operating expenses/);

  const capital = financeEventNotification(event({
    id: uuid(2), eventType: 'owner_transaction_recorded',
    idempotencyKey: `opening_capital:${ledgerId}`,
    payload: { type: 'opening_capital', amountMinor: 250000000 },
  }));
  const capitalHtml = renderTelegramHtml(capital!);
  assert.match(capitalHtml, /ALVERON CAPITAL UPDATED/);
  assert.match(capitalHtml, /₦2,500,000/);
  // Capital is never presented as an operating expense line item.
  assert.doesNotMatch(capitalHtml, /Operating Expenses/i);
});

test('a refund event preserves exact kobo amounts and masks the reference', () => {
  const notification = financeEventNotification(event({
    id: uuid(3), eventType: 'refund_recorded',
    payload: { orderId: uuid(9), orderNumber: 1042, amountMinor: 1234567, reference: 'PAY-ABCD1234' },
  }));
  const html = renderTelegramHtml(notification!);
  assert.match(html, /ALVERON REFUND RECORDED/);
  assert.match(html, /₦12,345\.67/);
  assert.match(html, /••••1234/);
  assert.doesNotMatch(html, /PAY-ABCD/);
});

test('unknown event payloads fail closed rather than inventing a notification', () => {
  // A malformed orderId must throw so the event stays pending.
  assert.throws(() => financeEventNotification(event({ id: uuid(4), eventType: 'refund_recorded', payload: {} })), /INVALID_RESPONSE/);
  // A withdrawal without an authoritative ledger id must throw.
  assert.throws(() => financeEventNotification(event({ id: uuid(5), eventType: 'owner_transaction_recorded',
    idempotencyKey: 'owner_tx:not-a-uuid', payload: { type: 'owner_draw', amountMinor: 1 } })), /INVALID_RESPONSE/);
  // ACK-only events return null (drained, not notified).
  assert.equal(financeEventNotification(event({ id: uuid(6), eventType: 'payment_confirmed', payload: {} })), null);
});

test('consumer acknowledges only after a successful notification and is idempotent per event', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const notifications = service(ledger, async () => { sends += 1; return { messageId: '1', simulated: false }; });
    const items = [
      event({ id: uuid(11), eventType: 'owner_transaction_recorded', idempotencyKey: `owner_tx:${uuid(20)}`,
        payload: { type: 'owner_draw', amountMinor: 100000 } }),
      event({ id: uuid(12), eventType: 'payment_confirmed', payload: {} }),
    ];
    const { client, acked } = eventClient(items);
    const workflow = new FinanceEventsConsumerWorkflow(client, notifications);
    const first = await workflow.run();
    assert.equal(first.acked, 2);
    assert.equal(first.notified, 1);
    assert.deepEqual(acked, [uuid(11), uuid(12)]);
    assert.equal(sends, 1);

    // Replayed event: notification is deduplicated, but ack is idempotent and still issued once.
    const second = await new FinanceEventsConsumerWorkflow(eventClient(items).client, notifications).run();
    assert.equal(second.acked, 2);
    assert.equal(sends, 1);
  } finally { ledger.close(); }
});

test('a failed notification leaves the event unacknowledged for retry', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => { throw new NotificationNotSent(); });
    const items = [event({ id: uuid(13), eventType: 'owner_transaction_recorded',
      idempotencyKey: `owner_tx:${uuid(21)}`, payload: { type: 'owner_draw', amountMinor: 100 } })];
    const { client, acked } = eventClient(items);
    const result = await new FinanceEventsConsumerWorkflow(client, notifications).run();
    assert.equal(result.acked, 0);
    assert.equal(result.unacked, 1);
    assert.deepEqual(acked, []);
  } finally { ledger.close(); }
});

test('an unknown event type is alerted once and never acknowledged', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const kinds: string[] = [];
    const notifications = service(ledger, async (notification) => { kinds.push(notification.kind); return { messageId: '1', simulated: false }; });
    const items = [event({ id: uuid(14), eventType: 'made_up_event', payload: {} })];
    const { client, acked } = eventClient(items);
    const result = await new FinanceEventsConsumerWorkflow(client, notifications).run();
    assert.equal(result.unhandled, 1);
    assert.equal(result.acked, 0);
    assert.deepEqual(acked, []);
    assert.ok(kinds.includes('FINANCE_UNAVAILABLE'));
  } finally { ledger.close(); }
});

test('an ack failure leaves the event pending and does not crash the run', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: '1', simulated: false }));
    const items = [event({ id: uuid(15), eventType: 'payment_confirmed', payload: {} })];
    const { client } = eventClient(items, { ackFails: true });
    const result = await new FinanceEventsConsumerWorkflow(client, notifications).run();
    assert.equal(result.acked, 0);
    assert.equal(result.unacked, 1);
    assert.equal(result.status, 'completed');
  } finally { ledger.close(); }
});

test('an empty outbox is a clean noop', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const notifications = service(ledger, async () => ({ messageId: '1', simulated: false }));
    const result = await new FinanceEventsConsumerWorkflow(eventClient([]).client, notifications).run();
    assert.equal(result.status, 'noop');
    assert.equal(result.acked, 0);
  } finally { ledger.close(); }
});
