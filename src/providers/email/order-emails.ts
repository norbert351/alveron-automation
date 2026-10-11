import type { Order } from '../../integrations/alveron/schemas.js';
import type { CustomerEmailTemplate, TransactionalEmail } from './templates.js';

/**
 * Which Alveron order status produces which customer email. `paid` is deliberately absent: the
 * paid-order workflow already sends the order/payment confirmation, so re-sending here would
 * duplicate the one message a customer must not receive twice. Return/refund statuses are also
 * absent: Alveron's returns module owns those customer emails.
 */
const STATUS_TEMPLATE: Record<string, { template: CustomerEmailTemplate; title: string; body: string }> = {
  processing: { template: 'order_processing', title: 'Your order is being processed',
    body: 'We have started preparing your order. We will let you know as soon as it moves on.' },
  packed: { template: 'order_packed', title: 'Your order is packed',
    body: 'Your order has been packed and is being prepared for the next step.' },
  ready_for_shipment: { template: 'order_packed', title: 'Your order is ready to ship',
    body: 'Your order is ready and will be handed to the courier shortly.' },
  shipped: { template: 'order_shipped', title: 'Your order has shipped',
    body: 'Your order is on its way. We will keep you updated as it progresses.' },
  in_transit: { template: 'order_out_for_delivery', title: 'Your order is out for delivery',
    body: 'Your order is out for delivery and should reach you soon.' },
  delivered: { template: 'order_delivered', title: 'Your order has been delivered',
    body: 'Your order has been delivered. Thank you for shopping with Alveron.' },
  ready_for_pickup: { template: 'order_ready_for_pickup', title: 'Your order is ready for pickup',
    body: 'Your order is ready for pickup. Please bring your order number when you collect it.' },
  picked_up: { template: 'order_picked_up', title: 'Your order has been picked up',
    body: 'Your order has been collected. Thank you for shopping with Alveron.' },
  cancelled: { template: 'order_cancelled', title: 'Your order was cancelled',
    body: 'Your order has been cancelled. If you did not expect this, please contact support.' },
};

export const CUSTOMER_STATUS_TEMPLATES = Object.keys(STATUS_TEMPLATE);

/** Builds the customer email for an observed order status, or null when no email applies. */
export function orderStatusEmail(order: Order): TransactionalEmail | null {
  const entry = STATUS_TEMPLATE[order.status.toLowerCase()];
  if (!entry || !order.customer_email) return null;
  const greeting = order.customer_name ? `Hello ${order.customer_name},\n\n` : '';
  return {
    template: entry.template,
    recipient: order.customer_email,
    subject: `${entry.title} — order #${order.order_number}`,
    text: `${greeting}${entry.title}.\n\n${entry.body}\n\nOrder number: #${order.order_number}\nTotal: NGN ${order.total}`,
    referenceId: order.id,
  };
}
