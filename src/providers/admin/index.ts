import { createHash } from 'node:crypto';
import { AppError } from '../../integrations/alveron/errors.js';
import type { Order, ReferralStats } from '../../integrations/alveron/schemas.js';
import type { ProductRequest } from '../../integrations/alveron/product-requests.js';
import type {
  FinanceCapital, FinanceDailyReport, FinanceExpense, FinanceMetrics, FinancePayable, FinancePeriod,
  FinanceReconciliationIssue, FinanceReviewQueue, FinanceWeeklyReport, FinanceWithdrawal,
} from '../../integrations/alveron/finance.js';
import { NotificationNotSent, type DeliveryReceipt } from '../notification-delivery.js';

export type AdminNotificationKind =
  | 'PAID_ORDER'
  | 'PAYMENT_FAILURE'
  | 'PAYMENT_RECONCILIATION'
  | 'ORDER_STATUS'
  | 'SHIPPING_SLA'
  | 'REFERRAL_PROCESSING'
  | 'AUTOMATION_ERROR'
  | 'PRODUCT_REQUEST'
  | 'PRODUCT_REQUEST_STATUS'
  | 'ORDER_ISSUE'
  | 'RESTOCK'
  | 'DAILY_OPERATIONS'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK'
  | 'SYSTEM_HEALTH'
  | 'FINANCE_DAILY_REPORT'
  | 'FINANCE_WEEKLY_REPORT'
  | 'FINANCE_RECONCILIATION'
  | 'FINANCE_EXPENSE_REVIEW'
  | 'FINANCE_PAYABLE'
  | 'FINANCE_REVIEW_DIGEST'
  | 'FINANCE_ANOMALY'
  | 'FINANCE_UNAVAILABLE'
  | 'OWNER_WITHDRAWAL'
  | 'FINANCE_REFUND'
  | 'FINANCE_CAPITAL'
  | 'TELEGRAM_TEST';

/**
 * Severity drives the emoji prefix on every alert. `ERROR` is retained for the existing
 * automation-error path (its heading already carries its own marker); `CRITICAL` is the
 * payment/security/system tier. Severity is always supplied by the caller building the
 * notification — it is never inferred from message text.
 */
export const severityPrefix = {
  INFO: '🟢',
  WARNING: '🟡',
  ERROR: '🔴',
  CRITICAL: '🔴',
} as const;

export type AdminNotificationSeverity = keyof typeof severityPrefix;

export interface AdminNotificationField {
  label: string;
  value: string;
}

export interface AdminNotification {
  kind: AdminNotificationKind;
  eventKey: string;
  resourceId: string;
  severity: AdminNotificationSeverity;
  heading: string;
  fields: readonly AdminNotificationField[];
  footer?: string;
}

export interface AdminNotificationProvider {
  readonly namespace: string;
  readonly enabled: boolean;
  send(notification: AdminNotification, eventKey: string): Promise<DeliveryReceipt>;
}

export type AdminNotificationResult =
  | { status: 'SUCCESS'; simulated: boolean }
  | { status: 'SKIPPED' }
  | { status: 'DISABLED' }
  | { status: 'FAILED'; reason: 'NOTIFICATION_NOT_SENT' | 'LEDGER_FAILURE' }
  | { status: 'PENDING'; reason: 'DELIVERY_RECONCILIATION_REQUIRED' | 'LEDGER_FAILURE' };

export interface AdminNotifier {
  notify(notification: AdminNotification): Promise<AdminNotificationResult>;
}

export const disabledAdminNotifier: AdminNotifier = {
  async notify() {
    return { status: 'DISABLED' };
  },
};

export class DisabledAdminNotificationProvider implements AdminNotificationProvider {
  readonly namespace = 'disabled';
  readonly enabled = false;
  async send(): Promise<DeliveryReceipt> {
    throw new NotificationNotSent();
  }
}

export type AutomationErrorNotificationInput = {
  workflow: string;
  executionId: string;
  category: string;
  errorCode: string;
  transient: boolean;
};

const errorCategories = new Set([
  'CONFIGURATION_ERROR', 'AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR', 'RATE_LIMITED',
  'ALVERON_SERVER_ERROR', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'VALIDATION_FAILED',
  'LEDGER_ERROR', 'UNKNOWN_ERROR',
]);
const errorCodes = new Set([
  ...errorCategories,
  'AUTHENTICATION_FAILED', 'ALVERON_API_FAILURE', 'CONFIG_INVALID', 'CUSTOMER_EMAIL_MISSING',
  'NOTIFICATION_NOT_SENT', 'DELIVERY_RECONCILIATION_REQUIRED', 'LEDGER_FAILURE',
  'GATEWAY_AUTHENTICATION_FAILED', 'GATEWAY_UNAVAILABLE', 'GATEWAY_RUN_FAILED',
  'FINANCE_ENDPOINT_UNAVAILABLE',
]);

const fail = (): never => { throw new AppError('VALIDATION_FAILED'); };
const text = (value: unknown, max: number): string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r]/.test(value) ? value : fail();
// A field label MAY be empty: the renderer renders an unlabeled value as a body line (see
// renderTelegramHtml). Values are never empty, but the test alert's opening line has no label.
const label = (value: unknown, max: number): string =>
  typeof value === 'string' && value.length <= max && !/[\0\r]/.test(value) ? value : fail();

function createNotification(
  kind: AdminNotificationKind,
  eventKey: string,
  resourceId: string,
  severity: AdminNotification['severity'],
  heading: string,
  fields: AdminNotificationField[],
  footer?: string,
): AdminNotification {
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(eventKey) || !/^[A-Za-z0-9:_-]{1,240}$/.test(resourceId) ||
      !fields.length || fields.length > 20) fail();
  const normalized = fields.map(field => ({ label: label(field.label, 80), value: text(field.value, 1000) }));
  return {
    kind, eventKey, resourceId, severity,
    heading: text(heading, 160), fields: normalized,
    ...(footer ? { footer: text(footer, 1000) } : {}),
  };
}

function naira(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) fail();
  return `₦${amount.toLocaleString('en-US')}`;
}

/** A per-line amount that never overflows: an absurd price×quantity falls back to the unit price. */
function lineAmount(price: number, quantity: number): string {
  const total = price * quantity;
  return Number.isSafeInteger(total) ? naira(total) : `${naira(price)} each`;
}

/**
 * Destination summary for the admin alert. Only fields Alveron actually returned are shown; a
 * pickup order and a shipping order each surface the destination the operator needs, and an order
 * with no delivery context simply omits the line rather than guessing.
 */
function deliverySummary(order: Order): string | null {
  if (order.fulfillment === 'pickup' || (!order.fulfillment && order.pickup_location_snapshot)) {
    const snapshot = order.pickup_location_snapshot;
    const place = snapshot
      ? [snapshot.name, [snapshot.city, snapshot.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ')
      : order.pickup_location;
    return place ? `Pickup — ${place}` : 'Pickup at store';
  }
  if (order.fulfillment === 'shipping' || order.shipping_address) {
    const address = order.shipping_address;
    const line = address ? [address.street, address.city, address.state, address.country].filter(Boolean).join(', ') : '';
    return line ? `Delivery — ${line}` : 'Delivery';
  }
  return null;
}

/** Bounded product list: variant/size/colour, quantity and line amount, capped to fit one field. */
function itemSummary(order: Order, maxLines = 12): string {
  const clean = (value: string): string => value.replace(/[\0\r]/g, ' ').trim();
  const lines = order.items.map((item, index) => {
    const variantTitle = item.variant_title ? clean(item.variant_title) : null;
    const variant = variantTitle || [item.variant_size, item.variant_color].filter(Boolean).map(value => clean(value!)).join(' · ') || null;
    return `${index + 1}. ${clean(item.title)}${variant ? ` (${variant})` : ''} × ${item.quantity} — ${lineAmount(item.price, item.quantity)}`;
  });
  const shown = lines.slice(0, maxLines);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more item line(s)`);
  const joined = shown.join('\n');
  return joined.length > 1000 ? `${joined.slice(0, 999)}…` : joined;
}

export function paidOrderNotification(order: Order): AdminNotification {
  const totalItems = order.items.reduce((count, item) => count + item.quantity, 0);
  const delivery = deliverySummary(order);
  const fields: AdminNotificationField[] = [
    { label: 'Order', value: `#${order.order_number}` },
    ...(order.customer_name ? [{ label: 'Customer', value: order.customer_name }] : []),
    { label: 'Products', value: itemSummary(order) },
    { label: 'Items', value: String(totalItems) },
    ...(order.subtotal > 0 ? [{ label: 'Subtotal', value: naira(order.subtotal) }] : []),
    ...(order.discount > 0 ? [{ label: 'Discount', value: `-${naira(order.discount)}` }] : []),
    { label: 'Shipping', value: order.shipping > 0 ? naira(order.shipping) : 'Free' },
    { label: 'Total', value: naira(order.total) },
    { label: 'Payment', value: order.payment_status },
    { label: 'Status', value: order.status },
    ...(delivery ? [{ label: 'Delivery', value: delivery }] : []),
  ];
  return createNotification('PAID_ORDER', `paid-order:${order.id}`, order.id, 'INFO', '🛍️ NEW PAID ORDER', fields,
    'Order received successfully.');
}

export function paymentFailureNotification(order: Order): AdminNotification {
  if (order.payment_status.toUpperCase() !== 'VERIFICATION_FAILED') fail();
  const eventResource = order.id;
  return createNotification('PAYMENT_FAILURE', `payment-failure:${eventResource}`, eventResource, 'WARNING',
    '⚠️ PAYMENT ISSUE', [
      { label: 'Order', value: `#${order.order_number}` },
      { label: 'Amount', value: naira(order.total) },
      { label: 'Status', value: order.payment_status },
      { label: 'Reason', value: 'Current payment verification failed' },
    ]);
}

export function referralProcessingNotification(windowId: string, stats: ReferralStats): AdminNotification {
  return createNotification('REFERRAL_PROCESSING', `referral:${windowId}`, windowId, 'INFO',
    '🎁 REFERRAL PROCESSING TRIGGERED', [
      { label: 'Window', value: windowId },
      { label: 'Side effect', value: 'Alveron referral processing invoked' },
      { label: 'Current qualified total', value: String(stats.qualified) },
      { label: 'Current rewarded total', value: String(stats.rewarded) },
    ], 'Alveron does not report how many individual referrals changed in this run.');
}

export function automationErrorNotification(input: AutomationErrorNotificationInput): AdminNotification {
  if (!errorCategories.has(input.category) || !errorCodes.has(input.errorCode) || typeof input.transient !== 'boolean') fail();
  const workflow = text(input.workflow, 200);
  const executionId = text(input.executionId, 200);
  const heading = input.transient ? '⚠️ AUTOMATION WARNING' : '🚨 AUTOMATION ERROR';
  const eventHash = createHash('sha256').update(`${executionId}\0${input.errorCode}`).digest('hex');
  return createNotification('AUTOMATION_ERROR', `automation-error:${eventHash}`, executionId,
    input.transient ? 'WARNING' : 'ERROR', heading, [
      { label: 'Workflow', value: workflow },
      { label: 'Category', value: input.category },
      { label: 'Error', value: input.errorCode },
      { label: 'Transient', value: input.transient ? 'Yes' : 'No' },
      { label: 'Action', value: input.transient ? 'Retry allowed by current workflow logic' : 'Manual investigation required' },
    ], 'Inspect n8n execution details for debugging. Secrets and stack traces are not included.');
}

/**
 * The automation outbox could not be read, or carried an event this build does not understand.
 * Reported once per (workflow, reason) so a persistent contract gap alerts without a flood.
 */
export function automationOutboxUnavailableNotification(workflow: string, reason: string): AdminNotification {
  const safeWorkflow = text(workflow, 80);
  const safeReason = text(reason, 120);
  const hash = createHash('sha256').update(`${safeWorkflow}\0${safeReason}`).digest('hex');
  return createNotification('AUTOMATION_ERROR', `automation-outbox:${hash}`, hash, 'ERROR',
    '🔴 AUTOMATION OUTBOX ISSUE', [
      { label: 'Workflow', value: safeWorkflow },
      { label: 'Reason', value: safeReason },
    ], 'Events are left pending and retried; nothing is acknowledged until it is handled.');
}

/**
 * New product-sourcing request. Only fields actually returned by Alveron are shown; anything
 * absent is omitted rather than guessed. The reference image is never attached: it lives in a
 * private bucket and this architecture cannot mint a signed URL, so the admin opens the
 * dashboard instead.
 */
export function productRequestNotification(request: ProductRequest): AdminNotification {
  const fields: AdminNotificationField[] = [];
  if (request.reference) fields.push({ label: 'Reference', value: request.reference });
  if (request.customerName) fields.push({ label: 'Customer', value: request.customerName });
  if (request.phone) fields.push({ label: 'Phone', value: request.phone });
  if (request.productType) fields.push({ label: 'Product Type', value: request.productType });
  if (request.size) fields.push({ label: 'Size', value: request.size });
  if (request.quantity !== null) fields.push({ label: 'Quantity', value: String(request.quantity) });
  if (request.status) fields.push({ label: 'Status', value: request.status });
  if (request.description) fields.push({ label: 'Description', value: request.description });
  // Identity is mandatory, so the alert is never an empty, unidentifiable message.
  if (!fields.length) fields.push({ label: 'Reference', value: request.id });
  return createNotification('PRODUCT_REQUEST', `product-request:${request.id}`, request.id, 'INFO',
    '🔎 NEW PRODUCT REQUEST', fields,
    'Reference image is stored privately. Open the Alveron admin dashboard to review it.');
}

export interface ProductRequestStatusInput {
  requestId: string;
  reference: string | null;
  previousStatus: string | null;
  status: string;
  quotedPrice: number | null;
}

/** An Alveron-confirmed product-request status transition. Read-only operational awareness. */
export function productRequestStatusNotification(input: ProductRequestStatusInput): AdminNotification {
  const status = text(input.status, 60);
  const fields: AdminNotificationField[] = [];
  if (input.reference) fields.push({ label: 'Reference', value: input.reference });
  if (input.previousStatus) fields.push({ label: 'Previous', value: text(input.previousStatus, 60) });
  fields.push({ label: 'Status', value: status });
  if (input.quotedPrice !== null) {
    if (!Number.isSafeInteger(input.quotedPrice) || input.quotedPrice < 0) fail();
    fields.push({ label: 'Quoted Price', value: naira(input.quotedPrice) });
  }
  const needsAction = ['quoted', 'customer_confirmed', 'paid'].includes(status.toLowerCase());
  return createNotification('PRODUCT_REQUEST_STATUS', `product-request-status:${input.requestId}:${status.toLowerCase()}`,
    input.requestId, needsAction ? 'INFO' : 'WARNING',
    needsAction ? '🛠️ PRODUCT REQUEST UPDATE' : '🔎 PRODUCT REQUEST STATUS', fields,
    'Read-only notification; Alveron owns the request lifecycle.');
}

export interface OrderIssueInput {
  orderIssueId: string;
  orderId: string;
  orderNumber: number | null;
  issueType: string | null;
  requestedSize: string | null;
  requestedColor: string | null;
  resolved: boolean;
}

/**
 * An order availability issue Alveron recorded. n8n never resolves the issue; it only informs the
 * admin that a customer needs a decision. The customer is contacted through Alveron's own flow.
 */
export function orderIssueNotification(input: OrderIssueInput): AdminNotification {
  const fields: AdminNotificationField[] = [
    ...(input.orderNumber !== null ? [{ label: 'Order', value: `#${text(String(input.orderNumber), 30)}` }] : []),
    ...(input.issueType ? [{ label: 'Issue', value: text(input.issueType, 80) }] : []),
    ...(input.requestedSize ? [{ label: 'Requested Size', value: text(input.requestedSize, 80) }] : []),
    ...(input.requestedColor ? [{ label: 'Requested Colour', value: text(input.requestedColor, 80) }] : []),
    { label: 'State', value: input.resolved ? 'Resolved' : 'Awaiting resolution' },
  ];
  return createNotification('ORDER_ISSUE', `order-issue:${input.orderIssueId}`, input.orderIssueId,
    input.resolved ? 'INFO' : 'WARNING',
    input.resolved ? '✅ ORDER ISSUE RESOLVED' : '⚠️ ORDER ISSUE', fields,
    'Resolve the issue in the Alveron admin dashboard; automation never changes an order.');
}

export interface RestockInput {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  stock: number;
}

/** A variant observed returning from zero to a positive stock. Deduplicated per restock level. */
export function restockNotification(input: RestockInput): AdminNotification {
  if (!Number.isSafeInteger(input.stock) || input.stock < 1) fail();
  const fields: AdminNotificationField[] = [{ label: 'Product', value: text(input.productTitle, 200) }];
  if (input.variantTitle) fields.push({ label: 'Variant', value: text(input.variantTitle, 200) });
  fields.push({ label: 'Restocked to', value: String(input.stock) });
  return createNotification('RESTOCK', `restock:${input.variantId}:${input.stock}`, input.variantId,
    'INFO', '📦 BACK IN STOCK', fields, 'Alveron inventory is authoritative; this is a read-only observation.');
}

export interface LowStockInput {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  stock: number;
  lowStockAlert: number;
}

/**
 * Low stock. Deduplicated per variant and per observed stock level by the caller, so a product
 * that stays below its threshold does not re-alert on every poll.
 */
export function lowStockNotification(input: LowStockInput): AdminNotification {
  if (!Number.isSafeInteger(input.stock) || input.stock < 0 ||
      !Number.isSafeInteger(input.lowStockAlert) || input.lowStockAlert < 0) fail();
  const fields: AdminNotificationField[] = [{ label: 'Product', value: text(input.productTitle, 200) }];
  if (input.variantTitle) fields.push({ label: 'Variant', value: text(input.variantTitle, 200) });
  fields.push({ label: 'Remaining', value: String(input.stock) });
  fields.push({ label: 'Low stock alert at', value: String(input.lowStockAlert) });
  return createNotification('LOW_STOCK', `low-stock:${input.variantId}:${input.stock}`, input.variantId,
    'WARNING', '📦 LOW STOCK', fields, 'Restock this variant in Alveron to clear the alert.');
}

export interface OutOfStockInput {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
}

/** A variant at zero stock. Distinct kind so it can never be conflated with a low-stock warning. */
export function outOfStockNotification(input: OutOfStockInput): AdminNotification {
  const fields: AdminNotificationField[] = [{ label: 'Product', value: text(input.productTitle, 200) }];
  if (input.variantTitle) fields.push({ label: 'Variant', value: text(input.variantTitle, 200) });
  fields.push({ label: 'Stock', value: '0' });
  return createNotification('OUT_OF_STOCK', `out-of-stock:${input.variantId}:0`, input.variantId,
    'WARNING', '📦 OUT OF STOCK', fields, 'Restock this variant in Alveron to clear the alert.');
}

/**
 * Order status transition observed from Alveron. The status is passed through verbatim; the
 * workflow never changes it. `previousStatus` is optional context only.
 */
export interface OrderStatusInput {
  orderId: string;
  orderNumber: number;
  status: string;
  previousStatus?: string | null;
}

const orderStatusHeadings: Record<string, string> = {
  processing: '🛠️ ORDER PROCESSING',
  packed: '📦 ORDER PACKED',
  ready_for_shipment: '📦 ORDER READY FOR SHIPMENT',
  shipped: '🚚 ORDER SHIPPED',
  in_transit: '🚚 ORDER IN TRANSIT',
  ready_for_pickup: '🏬 ORDER READY FOR PICKUP',
  picked_up: '✅ ORDER PICKED UP',
  delivered: '✅ ORDER DELIVERED',
  cancelled: '❌ ORDER CANCELLED',
  refunded: '💸 ORDER REFUNDED',
  refund_completed: '💸 ORDER REFUND COMPLETED',
};

export function orderStatusNotification(input: OrderStatusInput): AdminNotification {
  const status = text(input.status, 60);
  const heading = orderStatusHeadings[status.toLowerCase()] ?? '📋 ORDER STATUS UPDATED';
  const warning = ['cancelled', 'refunded', 'refund_completed'].includes(status.toLowerCase());
  const fields: AdminNotificationField[] = [
    { label: 'Order', value: `#${text(String(input.orderNumber), 30)}` },
    { label: 'Status', value: status },
  ];
  if (input.previousStatus) fields.push({ label: 'Previous', value: text(input.previousStatus, 60) });
  return createNotification('ORDER_STATUS', `order-status:${input.orderId}:${status.toLowerCase()}`,
    input.orderId, warning ? 'WARNING' : 'INFO', heading, fields,
    'Read-only notification; Alveron remains the source of truth for the transition.');
}

export interface ReconciliationFinding {
  code: string;
  orderId: string;
  orderNumber: number;
  paymentStatus: string;
  detail: string;
}

/**
 * An anomaly found during scheduled payment reconciliation. This notification NEVER carries a
 * remediation instruction that would mutate Alveron; it asks a human to review.
 */
export function paymentReconciliationNotification(finding: ReconciliationFinding): AdminNotification {
  const code = text(finding.code, 80);
  const severity = ['DUPLICATE_PAYMENT', 'PROVIDER_PAID_NOT_CONFIRMED', 'AMOUNT_MISMATCH']
    .includes(code) ? 'CRITICAL' : 'WARNING';
  return createNotification('PAYMENT_RECONCILIATION',
    `payment-reconciliation:${finding.orderId}:${code}`, finding.orderId, severity,
    `${severityPrefix[severity]} PAYMENT RECONCILIATION`, [
      { label: 'Order', value: `#${text(String(finding.orderNumber), 30)}` },
      { label: 'Payment', value: text(finding.paymentStatus, 60) },
      { label: 'Finding', value: code },
      { label: 'Reason', value: text(finding.detail, 300) },
    ], 'Review required in the Alveron admin dashboard. Automation never edits payment state.');
}

export interface ShippingSlaInput {
  waitingCount: number;
  oldestOrderId: string;
  oldestOrderNumber: number;
  slaHours: number;
}

/** Paid orders that have not shipped within the configured processing window. */
export function shippingSlaNotification(input: ShippingSlaInput): AdminNotification {
  if (!Number.isSafeInteger(input.waitingCount) || input.waitingCount < 1 ||
      !Number.isSafeInteger(input.slaHours) || input.slaHours < 1) fail();
  return createNotification('SHIPPING_SLA', `shipping-sla:${input.oldestOrderId}:${input.waitingCount}`,
    input.oldestOrderId, 'WARNING', '🟡 SHIPPING DELAY', [
      { label: 'Waiting', value: `${input.waitingCount} paid orders past the ${input.slaHours}h window` },
      { label: 'Oldest', value: `#${text(String(input.oldestOrderNumber), 30)}` },
    ], 'Automation does not mark orders shipped; the admin ships them in Alveron.');
}

export interface HealthCheckInput {
  environment: string;
  components: readonly { name: string; ok: boolean }[];
}

/** Aggregate automation-health snapshot. Only real component results are ever included. */
export function systemHealthNotification(input: HealthCheckInput): AdminNotification {
  const environment = text(input.environment, 80);
  if (!input.components.length || input.components.length > 20) fail();
  const fields: AdminNotificationField[] = input.components.map(component => ({
    label: text(component.name, 40),
    value: component.ok ? 'OK' : 'FAILED',
  }));
  const allOk = input.components.every(component => component.ok);
  const eventId = `${environment}:${allOk ? 'ok' : 'degraded'}`;
  return createNotification('SYSTEM_HEALTH', `system-health:${eventId}`, eventId,
    allOk ? 'INFO' : 'CRITICAL', allOk ? '🟢 ALVERON AUTOMATION HEALTH' : '🔴 ALVERON AUTOMATION HEALTH',
    fields, `Environment: ${environment}`);
}

export interface DailyOperationsInput {
  paidOrders: number;
  pendingOrders: number;
  cancelledOrders: number;
  processing: number;
  shipped: number;
  awaitingPickup: number;
  lowStock: number;
  outOfStock: number;
  newRequests: number;
  awaitingQuote: number;
  alveronHealthy: boolean;
  businessDate: string;
}

/**
 * Owner/admin daily operations summary. It is deliberately operational: finance figures stay with
 * the finance workflows, so this message never duplicates or invents revenue, cost or profit.
 * Counts are computed from the same authoritative reads the monitoring workflows use.
 */
export function dailyOperationsNotification(input: DailyOperationsInput): AdminNotification {
  const numbers = [input.paidOrders, input.pendingOrders, input.cancelledOrders, input.processing,
    input.shipped, input.awaitingPickup, input.lowStock, input.outOfStock, input.newRequests,
    input.awaitingQuote];
  if (numbers.some(value => !Number.isSafeInteger(value) || value < 0)) fail();
  const fields: AdminNotificationField[] = [
    { label: 'Paid orders', value: String(input.paidOrders) },
    { label: 'Pending orders', value: String(input.pendingOrders) },
    { label: 'Cancelled orders', value: String(input.cancelledOrders) },
    { label: 'Processing', value: String(input.processing) },
    { label: 'Shipped', value: String(input.shipped) },
    { label: 'Awaiting pickup', value: String(input.awaitingPickup) },
    { label: 'Low stock', value: String(input.lowStock) },
    { label: 'Out of stock', value: String(input.outOfStock) },
    { label: 'New requests', value: String(input.newRequests) },
    { label: 'Awaiting quote', value: String(input.awaitingQuote) },
    { label: 'Alveron API', value: input.alveronHealthy ? 'Healthy' : 'Degraded' },
  ];
  return createNotification('DAILY_OPERATIONS', `daily-operations:${text(input.businessDate, 20)}`,
    text(input.businessDate, 20), input.alveronHealthy ? 'INFO' : 'WARNING',
    '📊 ALVERON DAILY OPERATIONS', fields,
    'Operations only — finance figures are reported by the finance workflows.');
}

/**
 * ── Finance notifications ─────────────────────────────────────────────────────────────────────
 *
 * Every authoritative figure here is passed through verbatim from Alveron. Only explicitly
 * labelled "derived" fields (period-over-period changes and simple ratios) are computed, for
 * presentation. A field Alveron does not provide renders as "not provided" and is NEVER inferred.
 * Amounts are whole naira and may be negative (loss); customer PII and payment credentials never
 * appear.
 */
function signedNaira(value: number): string {
  if (!Number.isSafeInteger(value)) fail();
  return `${value < 0 ? '-' : ''}₦${Math.abs(value).toLocaleString('en-US')}`;
}

function financeMoney(value: number | null): string {
  return value === null ? 'not provided' : signedNaira(value);
}

/**
 * Finance outbox amounts arrive in minor units (kobo), unlike the whole-naira bridge endpoints.
 * Rendering is exact — no rounding — and shows kobo only when the value actually has any.
 */
function financeMinorMoney(value: number | null): string {
  if (value === null) return 'not provided';
  if (!Number.isSafeInteger(value)) fail();
  const major = Math.abs(value) / 100;
  const formatted = major.toLocaleString('en-US', {
    minimumFractionDigits: value % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}₦${formatted}`;
}

function financeCount(value: number | null): string {
  return value === null ? 'not provided' : String(value);
}

/**
 * Owner capital renders "Not entered" until the owner explicitly records an opening amount. A
 * `not_entered` state must never be shown as a fabricated ₦0.
 */
function financeCapital(capital: FinanceCapital | null): string {
  if (!capital) return 'not provided';
  if (capital.status === 'not_entered') return 'Not entered';
  return financeMoney(capital.openingCapital);
}

function financeDate(iso: string | null, timeZone: string): string {
  if (!iso) return 'not provided';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'not provided';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone }).format(date);
}

function financePeriodLabel(period: FinancePeriod, asOf: string, timeZone: string): string {
  const start = period.start ? financeDate(period.start, timeZone) : null;
  const end = period.end ? financeDate(period.end, timeZone) : null;
  if (start && end && start !== end) return `${start} – ${end}`;
  return end ?? start ?? financeDate(asOf, timeZone);
}

/**
 * The business date an authoritative value belongs to, expressed in the configured finance
 * timezone. Alveron's period boundaries are midnight in that timezone (e.g. `23:00Z` for
 * Africa/Lagos), so a raw UTC date slice would report the previous calendar day. Used only for
 * idempotency keys and operator-facing labels; it never changes a financial value.
 */
export function financeBusinessDate(iso: string | null, timeZone: string): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function financePeriodKey(period: FinancePeriod, asOf: string, timeZone: string): string {
  return financeBusinessDate(period.start ?? asOf, timeZone);
}

/** Derived presentation metric: period-over-period change. Never authoritative. */
function financeChange(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null || previous === 0) return null;
  const rounded = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}% vs previous`;
}

/** Derived presentation metric: a simple ratio. Never authoritative. */
function financeRatio(numerator: number | null, denominator: number | null): string | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

function financeList(lines: string[]): string | null {
  return lines.length ? lines.join('\n') : null;
}

function maskReference(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}

function changeField(labelText: string, current: number | null, previous: number | null): AdminNotificationField[] {
  const change = financeChange(current, previous);
  return change ? [{ label: labelText, value: change }] : [];
}

export function financeDailyReportNotification(report: FinanceDailyReport, timeZone: string): AdminNotification {
  const m: FinanceMetrics = report.current;
  const fields: AdminNotificationField[] = [
    { label: 'Revenue', value: financeMoney(m.revenue) },
    ...changeField('Revenue change (derived)', m.revenue, report.previous?.revenue ?? null),
    { label: 'COGS', value: financeMoney(m.cogs) },
    { label: 'Gross Profit', value: financeMoney(m.grossProfit) },
    { label: 'Expenses', value: financeMoney(m.operatingExpenses) },
    { label: 'Net Operating Profit', value: financeMoney(m.netProfit) },
  ];
  if (m.paymentFees !== null) fields.push({ label: 'Payment Fees', value: financeMoney(m.paymentFees) });
  if (m.refunds !== null) fields.push({ label: 'Refunds', value: financeMoney(m.refunds) });
  fields.push(
    { label: 'Supplier Payables', value: financeMoney(m.supplierPayables) },
    { label: 'Estimated Cash', value: financeMoney(report.estimatedCash) },
    { label: 'Review Required', value: financeCount(m.reviewItems) },
    { label: 'Reconciliation Issues', value: financeCount(m.reconciliationIssues) },
    { label: 'Capital', value: financeCapital(report.capital) },
    { label: 'Period', value: financePeriodLabel(report.period, report.asOf, timeZone) },
  );
  return createNotification('FINANCE_DAILY_REPORT',
    `finance-daily-report:${financePeriodKey(report.period, report.asOf, timeZone)}`,
    `finance-daily-report:${financePeriodKey(report.period, report.asOf, timeZone)}`, 'INFO',
    '💰 ALVERON DAILY FINANCE', fields,
    'Figures are authoritative from Alveron. Only change labels are derived for presentation.');
}

export function financeWeeklyReportNotification(report: FinanceWeeklyReport, timeZone: string): AdminNotification {
  const m = report.current;
  const fields: AdminNotificationField[] = [
    { label: 'Revenue', value: financeMoney(m.revenue) },
    ...changeField('Revenue change (derived)', m.revenue, report.previous?.revenue ?? null),
    { label: 'Orders', value: financeCount(m.orders) },
  ];
  const averageOrderValue = financeRatio(m.revenue, m.orders);
  if (averageOrderValue) fields.push({ label: 'Average order value (derived)', value: averageOrderValue });
  fields.push(
    { label: 'COGS', value: financeMoney(m.cogs) },
    { label: 'Gross Profit', value: financeMoney(m.grossProfit) },
  );
  const grossMargin = financeRatio(m.grossProfit, m.revenue);
  if (grossMargin) fields.push({ label: 'Gross margin (derived)', value: grossMargin });
  fields.push(
    { label: 'Operating Expenses', value: financeMoney(m.operatingExpenses) },
    { label: 'Net Operating Profit', value: financeMoney(m.netProfit) },
    { label: 'Refunds', value: financeMoney(m.refunds) },
    { label: 'Supplier Payables', value: financeMoney(m.supplierPayables) },
    { label: 'Estimated Cash', value: financeMoney(report.estimatedCash) },
    { label: 'Capital', value: financeCapital(report.capital) },
    { label: 'Owner withdrawals (cumulative)', value: report.capital ? financeMoney(report.capital.withdrawals) : 'not provided' },
  );
  const products = financeList(report.productProfitability.slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.title} — ${financeMoney(item.contributionProfit)}`));
  if (products) fields.push({ label: 'Top products by contribution', value: products });
  const expenses = financeList(report.largestExpenseCategories.slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.category} — ${financeMoney(item.amount)}`));
  if (expenses) fields.push({ label: 'Largest expense categories', value: expenses });
  fields.push(
    { label: 'Review Required', value: financeCount(m.reviewItems) },
    { label: 'Reconciliation Issues', value: financeCount(m.reconciliationIssues) },
    { label: 'Period', value: financePeriodLabel(report.period, report.asOf, timeZone) },
  );
  return createNotification('FINANCE_WEEKLY_REPORT',
    `finance-weekly-report:${financePeriodKey(report.period, report.asOf, timeZone)}`,
    `finance-weekly-report:${financePeriodKey(report.period, report.asOf, timeZone)}`, 'INFO',
    '📊 ALVERON WEEKLY FINANCE', fields,
    'Figures are authoritative from Alveron. Only change and ratio labels are derived for presentation.');
}

export function financeReconciliationNotification(issue: FinanceReconciliationIssue): AdminNotification {
  const fields: AdminNotificationField[] = [
    { label: 'Order', value: issue.orderNumber === null ? 'not provided' : `#${issue.orderNumber}` },
    { label: 'Finding', value: issue.code },
    { label: 'Expected', value: financeMoney(issue.expected) },
    { label: 'Actual', value: financeMoney(issue.actual) },
  ];
  const reference = maskReference(issue.reference);
  if (reference) fields.push({ label: 'Reference', value: reference });
  if (issue.detail) fields.push({ label: 'Detail', value: issue.detail });
  return createNotification('FINANCE_RECONCILIATION',
    `finance-reconciliation:${issue.id}:${issue.code}`, issue.id, 'CRITICAL',
    '🚨 ALVERON PAYMENT REVIEW', fields,
    'Review in Admin → Finance → Reconciliation. Automation never edits payment state.');
}

export function financeExpenseReviewNotification(expense: FinanceExpense, timeZone: string): AdminNotification {
  const fields: AdminNotificationField[] = [
    { label: 'Amount', value: financeMoney(expense.amount) },
    { label: 'Category', value: expense.category ?? 'Unknown' },
    { label: 'Description', value: expense.description ?? 'not provided' },
  ];
  if (expense.incurredAt) fields.push({ label: 'Recorded', value: financeDate(expense.incurredAt, timeZone) });
  return createNotification('FINANCE_EXPENSE_REVIEW',
    `finance-expense-review:${expense.id}`, expense.id, 'WARNING',
    '⚠️ EXPENSE REVIEW', fields,
    'Review in Alveron Finance. Automation does not approve expenses.');
}

export function financePayableNotification(payable: FinancePayable, timeZone: string): AdminNotification {
  const fields: AdminNotificationField[] = [
    { label: 'Supplier', value: payable.supplier },
    { label: 'Outstanding', value: financeMoney(payable.outstanding) },
    { label: 'Status', value: payable.status },
  ];
  if (payable.dueDate) fields.push({ label: 'Due', value: financeDate(payable.dueDate, timeZone) });
  const reference = maskReference(payable.reference);
  if (reference) fields.push({ label: 'Reference', value: reference });
  return createNotification('FINANCE_PAYABLE',
    `finance-payable:${payable.id}:${payable.status.toLowerCase()}`, payable.id, 'WARNING',
    '📦 SUPPLIER PAYMENT DUE', fields,
    'Review in Alveron Finance. Automation does not move money.');
}

const reviewKindLabels: Record<string, string> = {
  PAYMENT: 'Payment', RECONCILIATION: 'Reconciliation', EXPENSE: 'Expense',
  SUPPLIER: 'Supplier', MISSING_COST: 'Missing cost', REFUND: 'Refund',
  WITHDRAWAL: 'Owner withdrawal', OTHER: 'Item',
};

export function financeReviewDigestNotification(queue: FinanceReviewQueue, timeZone: string, maxItems = 10): AdminNotification {
  const total = queue.total;
  const shown = queue.items.slice(0, maxItems);
  const fields: AdminNotificationField[] = [
    { label: '', value: `${total} item${total === 1 ? '' : 's'} require attention` },
  ];
  shown.forEach((item, index) => {
    const labelText = reviewKindLabels[item.kind] ?? 'Item';
    const amount = item.amount === null ? '' : ` — ${signedNaira(item.amount)}`;
    fields.push({ label: '', value: `${index + 1}. ${labelText} — ${item.title}${amount}` });
  });
  if (total > shown.length) fields.push({ label: '', value: `…and ${total - shown.length} more.` });
  fields.push({ label: 'Period', value: financePeriodLabel({ start: null, end: queue.asOf }, queue.asOf, timeZone) });
  const digestHash = createHash('sha256')
    .update(queue.items.map(item => item.id).sort().join('|')).digest('hex').slice(0, 16);
  return createNotification('FINANCE_REVIEW_DIGEST',
    `finance-review-digest:${digestHash}`, digestHash, 'WARNING',
    '🔎 ALVERON FINANCE REVIEW', fields,
    'Open Alveron Admin → Finance.');
}

export interface FinanceAnomalyInput {
  signal: string;
  signalLabel: string;
  observed: number | null;
  threshold: number | null;
  period: FinancePeriod;
  asOf: string;
}

export function financeAnomalyNotification(input: FinanceAnomalyInput, timeZone: string): AdminNotification {
  const signal = text(input.signal, 60);
  const fields: AdminNotificationField[] = [
    { label: 'Signal', value: text(input.signalLabel, 160) },
    { label: 'Observed', value: financeMoney(input.observed) },
    { label: 'Threshold', value: input.threshold === null ? 'not provided' : signedNaira(input.threshold) },
    { label: 'Period', value: financePeriodLabel(input.period, input.asOf, timeZone) },
  ];
  return createNotification('FINANCE_ANOMALY',
    `finance-anomaly:${financePeriodKey(input.period, input.asOf, timeZone)}:${signal}`,
    `finance-anomaly:${financePeriodKey(input.period, input.asOf, timeZone)}:${signal}`, 'WARNING',
    '⚠️ FINANCE ANOMALY', fields,
    'Deterministic threshold crossing. Review in Alveron Admin → Finance.');
}

export function financeUnavailableNotification(workflow: string, reason: string): AdminNotification {
  const workflowName = text(workflow, 200);
  const reasonCode = text(reason, 120);
  const eventId = createHash('sha256').update(`${workflowName}\0${reasonCode}`).digest('hex').slice(0, 16);
  return createNotification('FINANCE_UNAVAILABLE', `finance-unavailable:${eventId}`, eventId, 'CRITICAL',
    '🚨 ALVERON FINANCE AUTOMATION ERROR', [
      { label: 'Workflow', value: workflowName },
      { label: 'Reason', value: reasonCode },
      { label: 'Source of truth', value: 'Alveron (unchanged)' },
      { label: 'Action', value: 'Review automation health' },
    ], 'Finance data could not be retrieved. The financial source of truth remains Alveron.');
}

export function ownerWithdrawalNotification(withdrawal: FinanceWithdrawal, timeZone: string): AdminNotification {
  const fields: AdminNotificationField[] = [
    { label: 'Type', value: withdrawal.type === 'CONTRIBUTION' ? 'Owner contribution' : 'Owner withdrawal' },
    { label: 'Amount', value: financeMoney(withdrawal.amount) },
  ];
  if (withdrawal.recordedAt) fields.push({ label: 'Recorded', value: financeDate(withdrawal.recordedAt, timeZone) });
  const reference = maskReference(withdrawal.reference);
  if (reference) fields.push({ label: 'Reference', value: reference });
  return createNotification('OWNER_WITHDRAWAL',
    `owner-withdrawal:${withdrawal.id}`, withdrawal.id, 'WARNING',
    '🏦 OWNER TRANSACTION', fields,
    'This is a financial review event, not an operating expense.');
}

/**
 * ── Finance outbox event notifications ───────────────────────────────────────────────────────
 *
 * Rendered from Alveron's `finance_events` payloads (minor units). Each builder reuses the SAME
 * ledger key as the equivalent polling workflow where one exists, so the shared SQLite ledger
 * guarantees at-most-once notification across both mechanisms. No field is invented; absent fields
 * render as "not provided".
 */
export interface FinanceExpenseReviewEventInput {
  id: string;
  amountMinor: number | null;
  description: string | null;
}

export function financeExpenseReviewEventNotification(input: FinanceExpenseReviewEventInput): AdminNotification {
  return createNotification('FINANCE_EXPENSE_REVIEW', `finance-expense-review:${input.id}`, input.id, 'WARNING',
    '⚠️ EXPENSE REVIEW', [
      { label: 'Amount', value: financeMinorMoney(input.amountMinor) },
      { label: 'Description', value: input.description ?? 'not provided' },
    ], 'Review in Alveron Finance. Automation does not approve expenses.');
}

export interface FinanceRefundEventInput {
  orderId: string;
  orderNumber: number | null;
  amountMinor: number | null;
  reference: string | null;
}

export function financeRefundEventNotification(input: FinanceRefundEventInput): AdminNotification {
  const fields: AdminNotificationField[] = [{ label: 'Amount', value: financeMinorMoney(input.amountMinor) }];
  if (input.orderNumber !== null) fields.push({ label: 'Order', value: `#${input.orderNumber}` });
  const reference = maskReference(input.reference);
  if (reference) fields.push({ label: 'Reference', value: reference });
  return createNotification('FINANCE_REFUND', `finance-refund:order:${input.orderId}`, input.orderId, 'WARNING',
    '💸 ALVERON REFUND RECORDED', fields,
    'Refunds affect authoritative finance totals. Review in Alveron Admin → Finance.');
}

export interface FinanceCapitalEventInput {
  ledgerId: string;
  amountMinor: number | null;
}

export function financeCapitalEventNotification(input: FinanceCapitalEventInput): AdminNotification {
  return createNotification('FINANCE_CAPITAL', `owner-withdrawal:${input.ledgerId}`, input.ledgerId, 'INFO',
    '💰 ALVERON CAPITAL UPDATED', [
      { label: 'Business capital recorded', value: financeMinorMoney(input.amountMinor) },
      { label: 'Finance dashboard', value: 'Updated' },
    ], 'Capital is owner equity; it is never revenue or an operating expense.');
}

export interface FinanceOwnerEventInput {
  ledgerId: string;
  amountMinor: number | null;
  kind: 'withdrawal' | 'contribution';
}

export function financeOwnerTransactionEventNotification(input: FinanceOwnerEventInput): AdminNotification {
  const withdrawal = input.kind === 'withdrawal';
  return createNotification('OWNER_WITHDRAWAL', `owner-withdrawal:${input.ledgerId}`, input.ledgerId, 'WARNING',
    withdrawal ? '⚠️ ALVERON OWNER WITHDRAWAL' : '💰 ALVERON OWNER CONTRIBUTION', [
      { label: 'Type', value: withdrawal ? 'Owner withdrawal' : 'Owner contribution' },
      { label: 'Amount', value: financeMinorMoney(input.amountMinor) },
    ], 'Owner transactions are equity movements, not operating expenses. Finance dashboard updated.');
}

export interface FinanceUnusualActivityInput {
  eventId: string;
  signal: string | null;
  detail: string | null;
}

export function financeUnusualActivityNotification(input: FinanceUnusualActivityInput): AdminNotification {
  return createNotification('FINANCE_ANOMALY', `finance-unusual:${input.eventId}`, input.eventId, 'WARNING',
    '⚠️ ALVERON FINANCE ANOMALY', [
      { label: 'Signal', value: input.signal ?? 'unusual_financial_activity' },
      { label: 'Detail', value: input.detail ?? 'not provided' },
    ], 'Deterministic finance observation. Review in Alveron Admin → Finance.');
}

export interface FinanceReconciliationEventInput {
  eventId: string;
  detail: string | null;
}

export function financeReconciliationEventNotification(input: FinanceReconciliationEventInput): AdminNotification {
  return createNotification('FINANCE_RECONCILIATION', `finance-reconciliation:event:${input.eventId}`, input.eventId, 'CRITICAL',
    '🚨 ALVERON PAYMENT REVIEW', [
      { label: 'Finding', value: 'RECONCILIATION_FAILED' },
      { label: 'Detail', value: input.detail ?? 'not provided' },
    ], 'Review in Admin → Finance → Reconciliation. Automation never edits payment state.');
}

export function telegramTestNotification(environment: string, eventId: string): AdminNotification {
  return createNotification('TELEGRAM_TEST', `telegram-test:${eventId}`, eventId, 'INFO',
    '🧪 ALVERON TELEGRAM TEST', [
      { label: '', value: 'Telegram admin notifications are configured successfully.' },
      { label: 'Environment', value: text(environment, 80) },
      { label: 'Gateway', value: 'Connected' },
      { label: 'n8n', value: 'Connected' },
    ]);
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fitEscaped(value: string, maxBytes: number): string {
  const escaped = escapeTelegramHtml(value);
  if (Buffer.byteLength(escaped, 'utf8') <= maxBytes) return escaped;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let end = middle;
    if (end > 0 && end < value.length) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end--;
    }
    if (Buffer.byteLength(escapeTelegramHtml(`${value.slice(0, end)}…`), 'utf8') <= maxBytes) low = end;
    else high = middle - 1;
  }
  return low ? escapeTelegramHtml(`${value.slice(0, low)}…`) : '';
}

export function renderTelegramHtml(notification: AdminNotification): string {
  const limit = 4096;
  const heading = fitEscaped(notification.heading, limit - 7);
  if (!heading) throw new NotificationNotSent();
  let rendered = `<b>${heading}</b>`;
  const append = (value: string, prefix = '') => {
    const separator = rendered ? '\n\n' : '';
    const available = limit - Buffer.byteLength(rendered + separator + prefix, 'utf8');
    const fitted = fitEscaped(value, available);
    if (fitted) rendered += separator + prefix + fitted;
  };
  for (const field of notification.fields) {
    const prefix = field.label ? `<b>${escapeTelegramHtml(field.label)}</b>\n` : '';
    append(field.value, prefix);
  }
  if (notification.footer) append(notification.footer);
  if (!rendered || Buffer.byteLength(rendered, 'utf8') > limit) throw new NotificationNotSent();
  return rendered;
}
