import type { AutomationMode } from '../../integrations/alveron/config.js';
import { NotificationNotSent, type DeliveryReceipt } from '../notification-delivery.js';
import type { EmailProvider, NotificationMessage } from './index.js';
import type { TransactionalEmail } from './templates.js';

/**
 * Makes `ALVERON_AUTOMATION_MODE` a real safety boundary for the one customer-facing side effect
 * this automation owns: the paid-order customer confirmation.
 *
 * - `live`     delegates every send to the configured provider.
 * - `test`     intercepts the customer confirmation and returns a simulated receipt; no network
 *              call, no customer contact. Detection and admin (Telegram) alerts still run.
 * - `disabled` never sends the customer confirmation and fails closed.
 *
 * The idempotency namespace is mode-scoped for `test`/`disabled`, so a simulated or suppressed
 * send can never occupy the live ledger key and suppress a real send after the mode changes.
 * Admin alerts are internal (operator-facing) and are deliberately not gated here; Telegram is
 * governed solely by `TELEGRAM_PROVIDER`.
 */
export class ModeAwareEmailProvider implements EmailProvider {
  constructor(private readonly delegate: EmailProvider, private readonly mode: AutomationMode) {}

  get namespace(): string {
    return this.mode === 'live' ? this.delegate.namespace : `${this.delegate.namespace}:${this.mode}`;
  }

  sendCustomerOrderConfirmation(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt> {
    if (this.mode === 'live') return this.delegate.sendCustomerOrderConfirmation(message, eventKey);
    if (this.mode === 'test') return Promise.resolve({ messageId: `simulated:${eventKey}`, simulated: true });
    return Promise.reject(new NotificationNotSent('CONFIGURATION_ERROR'));
  }

  sendCustomerTransactional(email: TransactionalEmail, eventKey: string): Promise<DeliveryReceipt> {
    if (this.mode === 'live') return this.delegate.sendCustomerTransactional(email, eventKey);
    if (this.mode === 'test') return Promise.resolve({ messageId: `simulated:${eventKey}`, simulated: true });
    return Promise.reject(new NotificationNotSent('CONFIGURATION_ERROR'));
  }

  sendAdminOrderAlert(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt> {
    return this.delegate.sendAdminOrderAlert(message, eventKey);
  }
}
