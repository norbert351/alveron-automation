import { randomUUID } from 'node:crypto';
import type { OrderClient } from '../integrations/alveron/client.js';
import { isPaid, validateConfirmation } from '../integrations/alveron/schemas.js';
import { safeCode } from '../integrations/alveron/errors.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import type { EmailProvider } from '../providers/email/index.js';
import { NotificationRunner } from './notification-runner.js';

export class PaidOrderWorkflow {
  private running = false;
  constructor(private readonly client: OrderClient, private readonly ledger: Ledger,
    private readonly provider: EmailProvider, private readonly adminEmail: string) {}

  async run() {
    const runId = randomUUID();
    if (this.running) return { runId, status: 'busy', discovered: 0, eligible: 0, processed: 0, skipped: 0, failed: 0, results: [] };
    this.running = true;
    try {
      const orders = await this.client.getOrders(); // Failure is never converted into an empty list.
      const candidates = orders.filter(order => isPaid(order.payment_status));
      const results: { orderId: string; status: string; reason?: string; simulated?: boolean }[] = [];
      const runner = new NotificationRunner(this.ledger, this.provider.namespace);
      for (const candidate of candidates) {
        try {
          const order = validateConfirmation(await this.client.getOrder(candidate.id), candidate.id);
          const items = order.items.map(i => `${i.title}${i.variant_title ? ` (${i.variant_title})` : ''}: ${i.quantity} x NGN ${i.price}`).join('\n');
          const message = { recipient: order.customer_email!, subject: `Order #${order.order_number} confirmation`,
            text: `${order.customer_name ? `Hello ${order.customer_name},\n` : ''}Order #${order.order_number}\n${items}\nTotal: NGN ${order.total}\nPayment status: ${order.payment_status}` };
          const customer = await runner.run(order.id, 'customer', key => this.provider.sendCustomerOrderConfirmation(message, key));
          if (customer.status === 'FAILED' || customer.status === 'PENDING') {
            results.push({ orderId: order.id, status: 'failed', reason: customer.reason }); continue;
          }
          // SKIPPED might mean a concurrent/ambiguous claim, not successful delivery.
          const customerKey = `${this.provider.namespace}:paid-order-confirmation:${order.id}:customer`;
          if (!this.ledger.has(customerKey)) {
            results.push({ orderId: order.id, status: 'failed', reason: 'DELIVERY_RECONCILIATION_REQUIRED' }); continue;
          }
          const admin = await runner.run(order.id, 'admin', key => this.provider.sendAdminOrderAlert({
            recipient: this.adminEmail, subject: `Paid order #${order.order_number}`,
            text: `Order ID: ${order.id}\nOrder #${order.order_number}\n${items}\nTotal: NGN ${order.total}\nPayment status: ${order.payment_status}\nRun: ${runId}\nEvent: ${key}\nProcessed at: ${new Date().toISOString()}`,
          }, key));
          const adminKey = `${this.provider.namespace}:paid-order-confirmation:${order.id}:admin`;
          if (admin.status === 'FAILED' || admin.status === 'PENDING' || !this.ledger.has(adminKey)) {
            results.push({ orderId: order.id, status: 'failed', reason: admin.status === 'FAILED' || admin.status === 'PENDING' ? admin.reason : 'DELIVERY_RECONCILIATION_REQUIRED' }); continue;
          }
          results.push({ orderId: order.id, status: customer.status === 'SKIPPED' && admin.status === 'SKIPPED' ? 'skipped' : 'processed',
            simulated: this.provider.namespace === 'development-console' });
        } catch (error) {
          const reason = safeCode(error);
          if (['CUSTOMER_EMAIL_MISSING', 'VALIDATION_FAILED', 'ALVERON_API_FAILURE'].includes(reason)) {
            const key = `${this.provider.namespace}:paid-order-validation:${candidate.id}`;
            const claim = this.ledger.claim(key, candidate.id, 'paid-order-validation');
            if (claim) this.ledger.markFailure(claim, reason);
          }
          results.push({ orderId: candidate.id, status: 'failed', reason });
        }
      }
      const count = (status: string) => results.filter(r => r.status === status).length;
      return { runId, status: count('failed') ? 'partial_failure' : 'completed', discovered: orders.length,
        eligible: candidates.length, processed: count('processed'), skipped: count('skipped'), failed: count('failed'), results };
    } finally { this.running = false; }
  }
}
