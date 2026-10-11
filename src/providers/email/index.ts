import { NotificationNotSent, type DeliveryReceipt } from '../notification-delivery.js';
import type { TransactionalEmail } from './templates.js';

export { NotificationNotSent, type DeliveryReceipt } from '../notification-delivery.js';
export { ResendEmailProvider, EmailNotSent, EmailDeliveryAmbiguous, type DeliveryFailure } from './resend.js';
export { ModeAwareEmailProvider } from './mode.js';
export { renderTransactionalEmail, escapeHtml, textToHtml, templateEyebrow } from './templates.js';
export type { CustomerEmailTemplate, TransactionalEmail } from './templates.js';

export interface NotificationMessage {
  recipient: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  readonly namespace: string;
  sendCustomerOrderConfirmation(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt>;
  sendAdminOrderAlert(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt>;
  sendCustomerTransactional(email: TransactionalEmail, eventKey: string): Promise<DeliveryReceipt>;
}

/** Logs metadata only: no body, full recipient, subject contents or credentials. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly namespace = 'development-console';
  constructor(private readonly sink: (line: string) => void = console.log) {}

  private async send(kind: string, message: { recipient: string; text: string }, eventKey: string): Promise<DeliveryReceipt> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.recipient)) throw new NotificationNotSent();
    const messageId = `console:${eventKey}`;
    this.sink(JSON.stringify({
      operation: kind, simulated: true, recipient: '[REDACTED]',
      subject: '[TRANSACTIONAL_NOTIFICATION]', characters: message.text.length,
    }));
    return { messageId, simulated: true };
  }

  sendCustomerOrderConfirmation(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt> {
    return this.send('customer_confirmation', message, eventKey);
  }
  sendAdminOrderAlert(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt> {
    return this.send('admin_alert', message, eventKey);
  }
  sendCustomerTransactional(email: TransactionalEmail, eventKey: string): Promise<DeliveryReceipt> {
    return this.send(`customer_transactional:${email.template}`, email, eventKey);
  }
}
