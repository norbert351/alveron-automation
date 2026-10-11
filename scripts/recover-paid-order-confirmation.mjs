// Controlled, single-order recovery for a historical paid-order customer confirmation.
// Dry-run by default: reads and validates the order and reports ledger state without sending.
// `--confirm` performs at most one real send through the SAME Resend notification path the
// workflow uses, so the ledger records a real provider message id or a real failure — it never
// fabricates a SUCCESS row. Idempotent: a record that is already SUCCESS is skipped, and the
// atomic ledger claim means concurrent runs cannot both send.
import { loadConfig } from '../dist/src/integrations/alveron/config.js';
import { makeClient } from '../dist/src/gateway/application.js';
import { SqliteLedger } from '../dist/src/ledger/sqlite-ledger.js';
import { ResendEmailProvider } from '../dist/src/providers/email/index.js';
import { NotificationRunner } from '../dist/src/workflows/notification-runner.js';
import { isId, validateConfirmation } from '../dist/src/integrations/alveron/schemas.js';
import { safeCode } from '../dist/src/integrations/alveron/errors.js';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ORDER_ID = 'abdcf733-3108-45e0-9cba-e31bd82e2904';

export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '[invalid]';
  const prefix = local.slice(0, 2);
  return `${prefix}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

export function buildConfirmationMessage(order) {
  const items = order.items
    .map(i => `${i.title}${i.variant_title ? ` (${i.variant_title})` : ''}: ${i.quantity} x NGN ${i.price}`)
    .join('\n');
  return {
    recipient: order.customer_email,
    subject: `Order #${order.order_number} confirmation`,
    text: `${order.customer_name ? `Hello ${order.customer_name},\n` : ''}Order #${order.order_number}\n${items}\nTotal: NGN ${order.total}\nPayment status: ${order.payment_status}`,
  };
}

export function customerKey(namespace, orderId) {
  return `${namespace}:paid-order-confirmation:${orderId}:customer`;
}

export async function recover({ client, ledger, provider, orderId, confirm = false }) {
  if (!isId(orderId)) throw new Error('INVALID_ORDER_ID');
  const raw = await client.getOrder(orderId);
  const order = validateConfirmation(raw, orderId);
  const message = buildConfirmationMessage(order);
  const liveKey = customerKey(provider.namespace, orderId);
  const before = ledger.get(liveKey);
  const summary = {
    orderId: order.id,
    orderNumber: order.order_number,
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    currency: order.currency,
    paymentRecords: order.payments.map(p => p.status),
    recipient: maskEmail(order.customer_email),
    subject: message.subject,
    liveNamespace: provider.namespace,
    liveKey,
    ledgerBefore: before ? { status: before.status, attempts: before.attempts, lastError: before.last_error, lastCategory: before.last_category } : null,
  };
  if (!confirm) return { mode: 'dry-run', sent: false, ...summary };
  const runner = new NotificationRunner(ledger, provider.namespace);
  const result = await runner.run(orderId, 'customer', key => provider.sendCustomerOrderConfirmation(message, key));
  const after = ledger.get(liveKey);
  return {
    mode: 'confirm', ...summary,
    result: result.status,
    simulated: result.status === 'SUCCESS' ? result.simulated : undefined,
    ledgerAfter: after ? { status: after.status, messageId: after.provider_message_id, attempts: after.attempts } : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const orderId = args.find(a => a.startsWith('--order-id='))?.slice('--order-id='.length) ?? DEFAULT_ORDER_ID;
  const confirm = args.includes('--confirm');
  const config = loadConfig();
  const client = makeClient(config);
  const ledger = new SqliteLedger(config.ledgerPath, 3);
  try {
    let provider;
    if (confirm) {
      if (config.emailProvider !== 'resend' || !config.resend) throw new Error('RESEND_NOT_CONFIGURED');
      provider = new ResendEmailProvider(config.resend);
    } else {
      provider = { namespace: config.resend ? 'resend' : 'resend' };
    }
    const candidates = (await client.getOrders()).filter(o => ['success', 'paid'].includes(o.payment_status.toLowerCase()));
    console.log(JSON.stringify({ paidCandidates: candidates.map(o => ({ id: o.id, payment_status: o.payment_status, created_at: o.created_at })) }));
    const outcome = await recover({ client, ledger, provider, orderId, confirm });
    console.log(JSON.stringify(outcome));
  } catch (error) {
    console.error(JSON.stringify({ status: 'recovery_failed', code: safeCode(error) }));
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
