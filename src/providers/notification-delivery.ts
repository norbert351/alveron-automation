import type { FailureCategory } from '../integrations/alveron/errors.js';

export interface DeliveryReceipt {
  messageId: string;
  simulated: boolean;
}

/**
 * A definite non-delivery: no message is in flight. An optional `category` lets a provider say
 * *why* it failed closed (e.g. an unconfigured provider) so the workflow result stays actionable
 * instead of collapsing to a generic error. Callers that do not classify get `INVALID_RESPONSE`.
 */
export class NotificationNotSent extends Error {
  constructor(public readonly category?: FailureCategory) {
    super('NOTIFICATION_NOT_SENT');
    this.name = 'NotificationNotSent';
  }
}
