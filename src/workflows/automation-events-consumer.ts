import { AppError, classifyFailure, safeCode } from '../integrations/alveron/errors.js';
import {
  isKnownAutomationEventType, type AutomationEvent, eventCount, eventText, eventUuid,
} from '../integrations/alveron/automation-events.js';
import { AUTOMATION_EVENTS_PATH, type AutomationEventClient } from '../integrations/alveron/client.js';
import {
  disabledAdminNotifier, automationOutboxUnavailableNotification,
  orderIssueNotification, productRequestStatusNotification,
  type AdminNotification, type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

/** Ceiling on events consumed in one run so a backlog cannot produce an unbounded burst. */
export const MAX_AUTOMATION_EVENTS_PER_RUN = 50;

/**
 * Events deliberately acknowledged without a Telegram notification. `product_request_created` is
 * already alerted by the product-request polling workflow; the order-issue contact/alternative
 * events are internal admin actions already performed through the dashboard.
 */
const ACK_ONLY_EVENT_TYPES = new Set([
  'product_request_created',
  'order_issue_customer_contacted',
  'order_issue_alternative_offered',
]);

/**
 * Maps one served automation event to an admin notification. Returns `null` for a recognised event
 * that must be acknowledged without notifying. Throws `INVALID_RESPONSE` if a payload field is
 * malformed, so the caller leaves the event pending and alerts instead of inventing data.
 */
export function automationEventNotification(event: AutomationEvent): AdminNotification | null {
  const payload = event.payload;
  if (ACK_ONLY_EVENT_TYPES.has(event.eventType)) return null;
  switch (event.eventType) {
    case 'product_request_status_changed':
      return productRequestStatusNotification({
        requestId: eventUuid(payload, 'productRequestId'),
        reference: eventText(payload, 'referenceCode', 80),
        previousStatus: eventText(payload, 'previousStatus', 60),
        status: eventText(payload, 'status', 60) ?? (() => { throw new AppError('INVALID_RESPONSE'); })(),
        quotedPrice: eventCount(payload, 'quotedPrice'),
      });
    case 'order_issue_created':
      return orderIssueNotification({
        orderIssueId: eventUuid(payload, 'orderIssueId'),
        orderId: eventUuid(payload, 'orderId'),
        orderNumber: eventCount(payload, 'orderNumber'),
        issueType: eventText(payload, 'issueType', 80),
        requestedSize: eventText(payload, 'requestedSize', 80),
        requestedColor: eventText(payload, 'requestedColor', 80),
        resolved: false,
      });
    case 'order_issue_resolved':
      return orderIssueNotification({
        orderIssueId: eventUuid(payload, 'orderIssueId'),
        orderId: eventUuid(payload, 'orderId'),
        orderNumber: eventCount(payload, 'orderNumber'),
        issueType: null,
        requestedSize: null,
        requestedColor: null,
        resolved: true,
      });
    default:
      throw new AppError('INVALID_RESPONSE');
  }
}

/**
 * ALV - Automation Events.
 *
 * Drains Alveron's authoritative `automation_events` outbox through the same typed read/ack
 * contract as the finance consumer: FETCH -> VALIDATE -> NOTIFY -> RECORD -> ACK. An event is never
 * acknowledged before it is handled, so a Telegram failure, a disabled provider or an ambiguous
 * send leaves it pending for a later retry. An unrecognised event type is alerted once and left
 * pending: fail-closed, never guessed. This workflow only notifies; it never mutates Alveron.
 */
export class AutomationEventsConsumerWorkflow {
  private running = false;
  constructor(
    private readonly client: AutomationEventClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('automation-events-consumer', AUTOMATION_EVENTS_PATH, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'An automation events pass is already running.' });
    this.running = true;
    try {
      const page = await this.client.listAutomationEvents('pending', 1, MAX_AUTOMATION_EVENTS_PER_RUN);
      let itemsFound = 0;
      let notified = 0;
      let duplicates = 0;
      let acked = 0;
      let unacked = 0;
      let unhandled = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const event of page.items) {
        itemsFound += 1;
        if (!isKnownAutomationEventType(event.eventType)) {
          unhandled += 1;
          notificationStatus = await safeNotify(this.adminNotifications,
            automationOutboxUnavailableNotification('automation-events-consumer', `UNKNOWN_EVENT_TYPE:${event.eventType}`));
          continue;
        }
        try {
          const notification = automationEventNotification(event);
          if (notification) {
            const status = await safeNotify(this.adminNotifications, notification);
            notificationStatus = status;
            const counts = tally(status);
            notified += counts.notified;
            duplicates += counts.duplicates;
            if (status !== 'SUCCESS' && status !== 'SKIPPED') { unacked += 1; continue; }
          }
          await this.client.ackAutomationEvent(event.id);
          acked += 1;
        } catch (error) {
          unacked += 1;
          notificationStatus = await safeNotify(this.adminNotifications,
            automationOutboxUnavailableNotification('automation-events-consumer', error instanceof AppError ? error.code : 'INTERNAL_ERROR'));
        }
      }
      if (!itemsFound) {
        return finish({ status: 'noop', message: 'No pending automation events.' });
      }
      return finish({ status: 'completed', itemsFound, notified, duplicates, acked, unacked, unhandled, notificationStatus,
        message: `Read ${itemsFound} pending automation event(s); ${acked} acknowledged, ${notified} notification(s) sent${unacked ? `, ${unacked} left pending` : ''}.` });
    } catch (error) {
      const code = safeCode(error);
      const failureCategory = classifyFailure(error);
      const notificationStatus = await safeNotify(this.adminNotifications,
        automationOutboxUnavailableNotification('automation-events-consumer', code));
      return finish({ status: 'failed', code, failureCategory, notificationStatus,
        message: 'Automation events could not be retrieved; no event was acknowledged.' });
    } finally { this.running = false; }
  }
}
