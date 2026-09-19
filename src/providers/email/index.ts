export interface NotificationMessage {
  recipient: string;
  subject: string;
  text: string;
}
export interface DeliveryReceipt {
  messageId: string;
  simulated: boolean;
}
export interface EmailProvider {
  readonly namespace: string;
  sendCustomerOrderConfirmation(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt>;
  sendAdminOrderAlert(message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt>;
}

/** A provider may use this ONLY when it can guarantee no message was accepted. */
export class NotificationNotSent extends Error {
  constructor() { super('NOTIFICATION_NOT_SENT'); }
}

/** Logs metadata only: no body, full recipient, subject contents or credentials. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly namespace = 'development-console';
  constructor(private readonly sink: (line: string) => void = console.log) {}

  private async send(kind: string, message: NotificationMessage, eventKey: string): Promise<DeliveryReceipt> {
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
}
