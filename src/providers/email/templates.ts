/**
 * Branded transactional email rendering. Pure string functions only: no customer data is added,
 * no secret is read, no URL is invented. Every dynamic value is HTML-escaped before it reaches the
 * document, so an order title or customer name can never inject markup into the email.
 */

/**
 * Stable customer-facing transactional templates. The identifier is fixed and reviewable; the
 * provider turns it into a branded subject/body without ever inventing customer or product facts.
 */
export type CustomerEmailTemplate =
  | 'order_confirmation'
  | 'payment_confirmation'
  | 'order_processing'
  | 'order_packed'
  | 'order_shipped'
  | 'order_out_for_delivery'
  | 'order_delivered'
  | 'order_ready_for_pickup'
  | 'order_picked_up'
  | 'order_cancelled'
  | 'product_request_update'
  | 'restock_available';

/** Human-readable eyebrow per template; fixed literals, never customer input. */
export const templateEyebrow: Record<CustomerEmailTemplate, string> = {
  order_confirmation: 'Order confirmation',
  payment_confirmation: 'Payment confirmed',
  order_processing: 'Order update',
  order_packed: 'Order update',
  order_shipped: 'Your order has shipped',
  order_out_for_delivery: 'Out for delivery',
  order_delivered: 'Delivered',
  order_ready_for_pickup: 'Ready for pickup',
  order_picked_up: 'Picked up',
  order_cancelled: 'Order cancelled',
  product_request_update: 'Product request update',
  restock_available: 'Back in stock',
};

/**
 * A customer-facing transactional message built from Alveron-authoritative data only. It carries
 * the stable template id, the idempotency event key (supplied at send time), a correlation
 * reference and the rendered content. No internal cost, admin note, secret or session token may
 * ever be placed here.
 */
export interface TransactionalEmail {
  template: CustomerEmailTemplate;
  recipient: string;
  subject: string;
  text: string;
  referenceId: string;
}

const htmlEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** Escapes the five HTML-significant characters. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => htmlEntities[character] ?? character);
}

/** Escapes then preserves line breaks; the only dynamic building block in the template. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

export interface TransactionalContent {
  subject: string;
  text: string;
}

const brandHeader = `
    <div style="text-align:center;padding:24px 0;border-bottom:1px solid #e7e7e5;">
      <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:4px;color:#111;margin:0;">ALVERON</p>
      <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:9px;letter-spacing:3px;color:#e8001a;margin:4px 0 0;">FASHION</p>
    </div>`;

/**
 * Renders one clean, responsive, Alveron-branded HTML message from the existing notification
 * text. The eyebrow is a fixed literal supplied by the provider, never customer input.
 */
export function renderTransactionalEmail(content: TransactionalContent, eyebrow: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(content.subject.slice(0, 200))}</title>
  </head>
  <body style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f5f3;padding:40px 20px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e7e7e5;">
      ${brandHeader}
      <div style="padding:32px;">
        <p style="font-size:11px;letter-spacing:2px;color:#e8001a;text-transform:uppercase;margin:0 0 16px;">${escapeHtml(eyebrow)}</p>
        <div style="font-size:14px;line-height:1.6;color:#111;">${textToHtml(content.text)}</div>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #e7e7e5;text-align:center;font-size:10px;color:#888;">
        This is an automated transactional message from Alveron Fashion.
      </div>
    </div>
  </body>
</html>`;
}
