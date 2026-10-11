import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../src/integrations/alveron/errors.js';
import {
  parseAutomationEventPage, type AutomationEvent, type AutomationEventPage,
} from '../../src/integrations/alveron/automation-events.js';
import type { AutomationEventClient } from '../../src/integrations/alveron/client.js';
import type { AdminNotification, AdminNotificationResult, AdminNotifier } from '../../src/providers/admin/index.js';
import { automationEventNotification, AutomationEventsConsumerWorkflow } from '../../src/workflows/automation-events-consumer.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const event = (over: Partial<AutomationEvent> & { eventType: string; payload: Record<string, unknown> }): AutomationEvent => ({
  id: ID(1), status: 'pending', idempotencyKey: null,
  createdAt: '2026-01-01T00:00:00.000Z', deliveredAt: null, ...over,
} as AutomationEvent);

const page = (items: AutomationEvent[]): AutomationEventPage =>
  ({ items, total: items.length, page: 1, pageSize: 50, pages: 1 });

function recorder(): { notifier: AdminNotifier; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notifier: {
      async notify(notification: AdminNotification): Promise<AdminNotificationResult> {
        sent.push(notification.eventKey);
        return { status: 'SUCCESS', simulated: true };
      },
    },
  };
}

class FakeClient implements AutomationEventClient {
  acked: string[] = [];
  constructor(private readonly response: AutomationEventPage, private readonly failAck = false) {}
  async listAutomationEvents(): Promise<AutomationEventPage> { return this.response; }
  async ackAutomationEvent(id: string): Promise<{ id: string; status: 'delivered' }> {
    if (this.failAck) throw new AppError('ALVERON_API_FAILURE');
    this.acked.push(id);
    return { id, status: 'delivered' };
  }
}

test('the automation outbox parser is strict and never fabricates events', () => {
  const raw = { id: ID(1), event_type: 'order_issue_created', payload: {}, status: 'pending',
    idempotency_key: null, created_at: '2026-01-01T00:00:00.000Z', delivered_at: null };
  const valid = parseAutomationEventPage({ items: [raw], total: 1, page: 1, pageSize: 50, pages: 1 });
  assert.equal(valid.items.length, 1);
  assert.throws(() => parseAutomationEventPage({ items: {}, total: 1, page: 1, pageSize: 50, pages: 1 }));
  assert.throws(() => parseAutomationEventPage({ items: [{ ...raw, event_type: 'BAD TYPE' }],
    total: 1, page: 1, pageSize: 50, pages: 1 }));
});

test('product-request and order-issue events map to admin notifications', () => {
  const pr = automationEventNotification(event({ eventType: 'product_request_status_changed', payload: {
    productRequestId: ID(2), referenceCode: 'ARP-000042', previousStatus: 'found', status: 'quoted', quotedPrice: 25000,
  } }));
  assert.ok(pr);
  assert.equal(pr!.kind, 'PRODUCT_REQUEST_STATUS');
  assert.equal(pr!.eventKey, `product-request-status:${ID(2)}:quoted`);

  const issue = automationEventNotification(event({ eventType: 'order_issue_created', payload: {
    orderIssueId: ID(3), orderId: ID(4), orderNumber: 1042, issueType: 'out_of_stock', requestedSize: '42',
  } }));
  assert.ok(issue);
  assert.equal(issue!.kind, 'ORDER_ISSUE');
  assert.equal(issue!.severity, 'WARNING');

  const resolved = automationEventNotification(event({ eventType: 'order_issue_resolved', payload: {
    orderIssueId: ID(3), orderId: ID(4), resolution: 'replacement',
  } }));
  assert.equal(resolved!.severity, 'INFO');
});

test('events already owned by other workflows are acknowledged without a duplicate alert', () => {
  assert.equal(automationEventNotification(event({ eventType: 'product_request_created', payload: { productRequestId: ID(2) } })), null);
  assert.equal(automationEventNotification(event({ eventType: 'order_issue_customer_contacted', payload: { orderIssueId: ID(3) } })), null);
  assert.equal(automationEventNotification(event({ eventType: 'order_issue_alternative_offered', payload: { orderIssueId: ID(3) } })), null);
});

test('handled events are acknowledged; a telegram failure leaves them pending', async () => {
  const ackOnly = event({ id: ID(10), eventType: 'product_request_created', payload: {} });
  const handled = event({ id: ID(11), eventType: 'product_request_status_changed',
    payload: { productRequestId: ID(2), status: 'quoted' } });
  const client = new FakeClient(page([ackOnly, handled]));
  const { notifier, sent } = recorder();
  const result = await new AutomationEventsConsumerWorkflow(client, notifier).run();
  assert.equal(result.status, 'completed');
  assert.equal(result.acked, 2);
  assert.equal(result.notified, 1);
  assert.deepEqual(client.acked, [ID(10), ID(11)]);
  assert.deepEqual(sent, [`product-request-status:${ID(2)}:quoted`]);

  const failing: AdminNotifier = { async notify() { throw new Error('telegram down'); } };
  const failClient = new FakeClient(page([handled]));
  const failResult = await new AutomationEventsConsumerWorkflow(failClient, failing).run();
  assert.equal(failResult.unacked, 1);
  assert.deepEqual(failClient.acked, []);
});

test('an unknown event type is left pending and alerted, never guessed', async () => {
  const unknown = event({ id: ID(20), eventType: 'some_future_event', payload: {} });
  const client = new FakeClient(page([unknown]));
  const { notifier, sent } = recorder();
  const result = await new AutomationEventsConsumerWorkflow(client, notifier).run();
  assert.equal(result.unhandled, 1);
  assert.equal(result.acked, 0);
  assert.deepEqual(client.acked, []);
  assert.equal(sent.length, 1);
});

test('a retrieval failure acks nothing and reports a failure', async () => {
  class BrokenClient implements AutomationEventClient {
    async listAutomationEvents(): Promise<AutomationEventPage> { throw new AppError('ALVERON_API_FAILURE'); }
    async ackAutomationEvent(id: string): Promise<{ id: string; status: 'delivered' }> { return { id, status: 'delivered' }; }
  }
  const { notifier } = recorder();
  const result = await new AutomationEventsConsumerWorkflow(new BrokenClient(), notifier).run();
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ALVERON_API_FAILURE');
});
