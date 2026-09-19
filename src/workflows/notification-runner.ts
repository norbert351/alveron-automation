import type { Ledger } from '../ledger/sqlite-ledger.js';
import { NotificationNotSent, type DeliveryReceipt } from '../providers/email/index.js';

export type NotificationResult =
  | { status: 'SUCCESS'; simulated: boolean }
  | { status: 'SKIPPED' }
  | { status: 'FAILED'; reason: 'NOTIFICATION_NOT_SENT' }
  | { status: 'PENDING'; reason: 'DELIVERY_RECONCILIATION_REQUIRED' };

/** Internal slice: caller must retrieve/validate the real order before supplying send. */
export class NotificationRunner {
  constructor(private readonly ledger: Ledger, private readonly providerNamespace: string) {}

  async run(orderId: string, channel: 'customer' | 'admin', send: (key: string) => Promise<DeliveryReceipt>): Promise<NotificationResult> {
    const key = `${this.providerNamespace}:paid-order-confirmation:${orderId}:${channel}`;
    const claim = this.ledger.claim(key, orderId, `paid-order-confirmation:${channel}`);
    if (!claim) return { status: 'SKIPPED' };

    let receipt: DeliveryReceipt;
    try {
      receipt = await send(key);
    } catch (error) {
      if (error instanceof NotificationNotSent) {
        this.ledger.markFailure(claim);
        return { status: 'FAILED', reason: 'NOTIFICATION_NOT_SENT' };
      }
      // No stale reclaim: the provider may have accepted a message before disconnecting.
      // A human must reconcile this PENDING record before another send is allowed.
      return { status: 'PENDING', reason: 'DELIVERY_RECONCILIATION_REQUIRED' };
    }
    // A failed completion write leaves PENDING, never a retryable FAILED record.
    this.ledger.markSuccess(claim, receipt.messageId);
    return { status: 'SUCCESS', simulated: receipt.simulated };
  }
}
