import { AppError, safeCode } from '../integrations/alveron/errors.js';
import {
  FINANCE_EVENTS_PATH, eventCount, eventMoney, isKnownFinanceEventType,
  ownerLedgerIdFromIdempotencyKey, type FinanceEvent,
} from '../integrations/alveron/finance.js';
import type { FinanceEventClient } from '../integrations/alveron/client.js';
import {
  disabledAdminNotifier,
  financeCapitalEventNotification,
  financeExpenseReviewEventNotification,
  financeOwnerTransactionEventNotification,
  financeReconciliationEventNotification,
  financeRefundEventNotification,
  financeUnavailableNotification,
  financeUnusualActivityNotification,
  type AdminNotification,
  type AdminNotifier,
} from '../providers/admin/index.js';
import { createFinanceRun, notifyFinanceFailure, safeNotify, tally, type FinanceWorkflowResult } from './finance-support.js';

/** Ceiling on events consumed in one run so a backlog cannot produce an unbounded burst. */
export const MAX_FINANCE_EVENTS_PER_RUN = 50;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadText(payload: Record<string, unknown>, key: string, max = 300): string | null {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new AppError('INVALID_RESPONSE');
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function payloadUuid(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new AppError('INVALID_RESPONSE');
  return value.toLowerCase();
}

/**
 * Events deliberately acknowledged without a Telegram notification because an existing polling
 * workflow already owns the same business alert (paid orders, expense list, supplier payables) or
 * because the event is purely informational. They are still drained from the outbox so it cannot
 * stall behind them.
 */
const ACK_ONLY_EVENT_TYPES = new Set([
  'payment_confirmed', 'sale_recorded', 'expense_created', 'expense_approved',
  'supplier_payment_due', 'supplier_payment_recorded',
]);

/**
 * Maps one served outbox event to an admin notification. Returns `null` for a recognised event
 * that must be acknowledged without notifying. Throws `INVALID_RESPONSE` if a payload field is
 * malformed, so the caller leaves the event pending and alerts instead of inventing data.
 */
export function financeEventNotification(event: FinanceEvent): AdminNotification | null {
  const payload = event.payload;
  if (ACK_ONLY_EVENT_TYPES.has(event.eventType)) return null;
  switch (event.eventType) {
    case 'refund_recorded':
      return financeRefundEventNotification({
        orderId: payloadUuid(payload, 'orderId'),
        orderNumber: eventCount(payload, 'orderNumber'),
        amountMinor: eventMoney(payload, 'amountMinor'),
        reference: payloadText(payload, 'reference', 120),
      });
    case 'expense_requires_review':
      return financeExpenseReviewEventNotification({
        id: payloadUuid(payload, 'expenseId'),
        amountMinor: eventMoney(payload, 'amountMinor'),
        description: payloadText(payload, 'description'),
      });
    case 'owner_transaction_recorded': {
      const ledgerId = ownerLedgerIdFromIdempotencyKey(event.idempotencyKey);
      if (!ledgerId) throw new AppError('INVALID_RESPONSE');
      const amountMinor = eventMoney(payload, 'amountMinor');
      const kind = payloadText(payload, 'type', 40);
      if (kind === 'opening_capital') return financeCapitalEventNotification({ ledgerId, amountMinor });
      if (kind === 'owner_draw') return financeOwnerTransactionEventNotification({ ledgerId, amountMinor, kind: 'withdrawal' });
      if (kind === 'owner_contribution') return financeOwnerTransactionEventNotification({ ledgerId, amountMinor, kind: 'contribution' });
      throw new AppError('INVALID_RESPONSE');
    }
    case 'unusual_financial_activity':
      return financeUnusualActivityNotification({
        eventId: event.id,
        signal: payloadText(payload, 'kind', 60),
        detail: payloadText(payload, 'message'),
      });
    case 'reconciliation_failed':
      return financeReconciliationEventNotification({
        eventId: event.id,
        detail: payloadText(payload, 'message') ?? payloadText(payload, 'detail'),
      });
    default:
      throw new AppError('INVALID_RESPONSE');
  }
}

/**
 * ALVERON - Finance - Events Consumer.
 *
 * Drains Alveron's authoritative `finance_events` outbox through the typed read/ack contract:
 * FETCH -> VALIDATE -> PROCESS -> NOTIFY -> RECORD SUCCESS -> ACK. An event is never acknowledged
 * before its notification succeeded, so a Telegram failure, a disabled provider or an ambiguous
 * send leaves the event pending for a later retry. Every event is idempotent on the authoritative
 * event identity (`finance-event:<id>` at the notification layer, plus the shared ledger keys that
 * the polling workflows use). An unrecognised event type is alerted once and left pending:
 * fail-closed, never guessed.
 */
export class FinanceEventsConsumerWorkflow {
  private running = false;
  constructor(
    private readonly client: FinanceEventClient,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<FinanceWorkflowResult> {
    const { finish } = createFinanceRun('finance-events-consumer', FINANCE_EVENTS_PATH, this.now);
    if (this.running) return finish({ status: 'busy', code: 'BUSY', message: 'A finance events pass is already running.' });
    this.running = true;
    try {
      const page = await this.client.listFinanceEvents('pending', 1, MAX_FINANCE_EVENTS_PER_RUN);
      let itemsFound = 0;
      let notified = 0;
      let duplicates = 0;
      let acked = 0;
      let unacked = 0;
      let unhandled = 0;
      let notificationStatus: FinanceWorkflowResult['notificationStatus'] = 'DISABLED';
      for (const event of page.items) {
        itemsFound += 1;
        if (!isKnownFinanceEventType(event.eventType)) {
          unhandled += 1;
          notificationStatus = await safeNotify(this.adminNotifications,
            financeUnavailableNotification('finance-events-consumer', `UNKNOWN_EVENT_TYPE:${event.eventType}`));
          continue;
        }
        try {
          const notification = financeEventNotification(event);
          if (notification) {
            const status = await safeNotify(this.adminNotifications, notification);
            notificationStatus = status;
            const counts = tally(status);
            notified += counts.notified;
            duplicates += counts.duplicates;
            if (status !== 'SUCCESS' && status !== 'SKIPPED') { unacked += 1; continue; }
          }
          await this.client.ackFinanceEvent(event.id);
          acked += 1;
        } catch (error) {
          unacked += 1;
          notificationStatus = await safeNotify(this.adminNotifications,
            financeUnavailableNotification('finance-events-consumer', safeCode(error)));
        }
      }
      if (!itemsFound) {
        return finish({ status: 'noop', message: 'No pending finance events.' });
      }
      return finish({ status: 'completed', itemsFound, notified, duplicates, acked, unacked, unhandled, notificationStatus,
        message: `Read ${itemsFound} pending finance event(s); ${acked} acknowledged, ${notified} notification(s) sent${unacked ? `, ${unacked} left pending` : ''}.` });
    } catch (error) {
      const failure = await notifyFinanceFailure(this.adminNotifications, 'finance-events-consumer', error);
      return finish({ status: 'failed', code: failure.code, failureCategory: failure.failureCategory,
        notificationStatus: failure.notificationStatus,
        message: 'Finance events could not be retrieved; no event was acknowledged.' });
    } finally { this.running = false; }
  }
}
