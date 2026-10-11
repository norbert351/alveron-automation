import { AppError } from './errors.js';
import { validEmail } from './config.js';
export interface OrderItem {
  title: string;
  variant_title: string | null;
  variant_size: string | null;
  variant_color: string | null;
  quantity: number;
  price: number;
}
export interface Payment { id: string; order_id: string; provider_reference: string; status: string; amount: number; currency: string; }
/**
 * Delivery context captured from the order row so the admin alert can state where an order goes.
 * Every field is optional: a pickup order has no shipping address and vice versa, and older orders
 * may predate the JSONB snapshots. Absent values are omitted, never guessed.
 */
export interface ShippingAddress {
  full_name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  landmark: string | null;
}
export interface PickupSnapshot {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}
export interface Order {
  id: string; order_number: number; status: string; payment_status: string;
  customer_email: string | null; customer_name: string | null;
  total: number; subtotal: number; shipping: number; discount: number; currency: string;
  /** Fulfilment method (`shipping`|`pickup`) and the resolved destination, all optional. */
  fulfillment: string | null; pickup_location: string | null;
  shipping_address: ShippingAddress | null; pickup_location_snapshot: PickupSnapshot | null;
  /**
   * Timestamps are captured tolerantly: the live `GET /orders` envelope may or may not include
   * them. Absent or unparsable dates become `null` and any workflow that needs a timestamp must
   * skip the order rather than assume one. Never fabricated.
   */
  created_at: string | null; updated_at: string | null; payment_date: string | null;
  items: OrderItem[]; payments: Payment[];
}
export const isPaid = (status: string): boolean => ['success', 'paid'].includes(status.toLowerCase());
export const isId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const fail = (): never => { throw new AppError('VALIDATION_FAILED'); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
const text = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 1000 ? value : fail();
const optional = (value: unknown): string | null => value == null ? null : text(value);
const money = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail();
/**
 * An optional ISO-8601 timestamp. Anything absent, malformed or absurd is `null` — never a
 * guessed date. Parsing is strict about shape and accepts only a real calendar instant.
 */
const optionalTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
/**
 * Presentation-only string for the admin alert. Unlike `text`, an unexpected shape collapses to
 * `null` instead of failing the whole order: delivery context must never block a valid payment.
 */
const displayText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\0\r]/.test(value) ? value : null;
const parseShippingAddress = (value: unknown): ShippingAddress | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const address = {
    full_name: displayText(a['full_name']), street: displayText(a['street']), city: displayText(a['city']),
    state: displayText(a['state']), country: displayText(a['country']), landmark: displayText(a['landmark']),
  };
  return Object.values(address).some(part => part !== null) ? address : null;
};
const parsePickupSnapshot = (value: unknown): PickupSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const snapshot = {
    name: displayText(p['name']), address: displayText(p['address']),
    city: displayText(p['city']), state: displayText(p['state']),
  };
  return Object.values(snapshot).some(part => part !== null) ? snapshot : null;
};
export function parseOrder(value: unknown): Order {
  const o = object(value);
  const id = text(o.id);
  if (!isId(id) || !Array.isArray(o.items) || !Array.isArray(o.payments)) return fail();
  return { id, order_number: money(o.order_number), status: text(o.status), payment_status: text(o.payment_status),
    customer_email: optional(o.customer_email), customer_name: optional(o.customer_name),
    total: money(o.total), subtotal: money(o.subtotal), shipping: money(o.shipping), discount: money(o.discount), currency: text(o.currency),
    fulfillment: optional(o.fulfillment), pickup_location: optional(o.pickup_location),
    shipping_address: parseShippingAddress(o.shipping_address), pickup_location_snapshot: parsePickupSnapshot(o.pickup_location_snapshot),
    created_at: optionalTimestamp(o.created_at), updated_at: optionalTimestamp(o.updated_at),
    payment_date: optionalTimestamp(o.payment_date),
    items: o.items.map(value => { const i = object(value); return { title: text(i.title), variant_title: optional(i.variant_title),
      variant_size: optional(i.variant_size), variant_color: optional(i.variant_color), quantity: money(i.quantity), price: money(i.price) }; }),
    payments: o.payments.map(value => { const p = object(value); return { id: text(p.id), order_id: text(p.order_id),
      provider_reference: text(p.provider_reference), status: text(p.status), amount: money(p.amount), currency: text(p.currency) }; }),
  };
}
export function parseOrders(value: unknown): Order[] {
  if (!Array.isArray(value)) return fail();
  return value.map(parseOrder);
}
/**
 * GET /referrals/admin/stats response. Field names are exactly those returned by
 * Alveron's getAdminReferralStats(): aggregates only, no emails, names or referral codes.
 */
export interface ReferralStats {
  total: number; pending: number; qualified: number; rewarded: number; cancelled: number;
  totalDiscounts: number; totalRewards: number; totalCreditIssued: number; totalCreditRedeemed: number;
  conversionRate: number;
}
export function parseReferralStats(value: unknown): ReferralStats {
  // A 200 response with an unexpected shape is a failure, never "zero referrals processed".
  const badResponse = (): never => { throw new AppError('INVALID_RESPONSE'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badResponse();
  const s = value as Record<string, unknown>;
  const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : badResponse();
  return { total: count(s['total']), pending: count(s['pending']), qualified: count(s['qualified']),
    rewarded: count(s['rewarded']), cancelled: count(s['cancelled']), totalDiscounts: count(s['totalDiscounts']),
    totalRewards: count(s['totalRewards']), totalCreditIssued: count(s['totalCreditIssued']),
    totalCreditRedeemed: count(s['totalCreditRedeemed']), conversionRate: count(s['conversionRate']) };
}
export function validatePaidOrder(order: Order, expectedId: string): Order {
  if (order.id !== expectedId || !isPaid(order.payment_status) || order.currency !== 'NGN') return fail();
  if (!['paid', 'processing', 'packed', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered'].includes(order.status)) return fail();
  if (!order.items.length || order.items.some(i => i.quantity < 1)) return fail();
  if (order.payments.some(p => p.order_id !== order.id || p.currency !== 'NGN')) return fail();
  return order;
}

export function validateConfirmation(order: Order, expectedId: string): Order {
  const validated = validatePaidOrder(order, expectedId);
  if (!validated.customer_email) throw new AppError('CUSTOMER_EMAIL_MISSING');
  if (!validEmail(validated.customer_email)) return fail();
  return validated;
}
