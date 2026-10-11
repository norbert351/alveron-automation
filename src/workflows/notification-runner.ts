import type { FailureCategory } from '../integrations/alveron/errors.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import { NotificationNotSent, type DeliveryReceipt } from '../providers/notification-delivery.js';

export type NotificationResult =
  | { status: 'SUCCESS'; simulated: boolean }
  | { status: 'SKIPPED' }
  | { status: 'FAILED'; reason: 'NOTIFICATION_NOT_SENT'; category: FailureCategory }
  | { status: 'PENDING'; reason: 'DELIVERY_RECONCILIATION_REQUIRED'; category: FailureCategory };

/** Internal slice: caller must retrieve/validate the real order before supplying send. */
export class NotificationRunner {
  constructor(private readonly ledger: Ledger, private readonly providerNamespace: string) {}

  async run(
    orderId: string,
    channel: 'customer' | 'admin',
    send: (key: string) => Promise<DeliveryReceipt>,
    eventType = 'paid-order-confirmation',
  ): Promise<NotificationResult> {
    const key = `${this.providerNamespace}:${eventType}:${orderId}:${channel}`;
    const claim = this.ledger.claim(key, orderId, `${eventType}:${channel}`);
    if (!claim) return { status: 'SKIPPED' };

    let receipt: DeliveryReceipt;
    try {
      receipt = await send(key);
    } catch (error) {
      if (error instanceof NotificationNotSent) {
        this.ledger.markFailure(claim, 'NOTIFICATION_NOT_SENT', error.category ?? 'INVALID_RESPONSE');
        return { status: 'FAILED', reason: 'NOTIFICATION_NOT_SENT', category: error.category ?? 'INVALID_RESPONSE' };
      }
      // No stale reclaim: the provider may have accepted a message before disconnecting.
      // A human must reconcile this PENDING record before another send is allowed.
      return { status: 'PENDING', reason: 'DELIVERY_RECONCILIATION_REQUIRED', category: 'UNKNOWN_ERROR' };
    }
    // A failed completion write leaves PENDING, never a retryable FAILED record.
    this.ledger.markSuccess(claim, receipt.messageId);
    return { status: 'SUCCESS', simulated: receipt.simulated };
  }
}
