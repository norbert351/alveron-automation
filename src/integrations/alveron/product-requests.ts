import { AppError } from './errors.js';

/**
 * New product-sourcing request projection of `GET /admin/product-requests`.
 *
 * This feature postdates the Alveron reference documentation in docs/, and the endpoint
 * returned zero rows when first probed, so the row schema could not be observed directly.
 * The parser is therefore DELIBERATELY TOLERANT on display fields and STRICT on identity:
 *
 *  - Identity (`id`, else `reference`) is required. It is the idempotency key, so a row that
 *    cannot be identified is skipped rather than risking duplicate admin alerts.
 *  - Every customer-facing field is optional and omitted when absent or malformed. The admin
 *    is never shown a guessed or mis-mapped value.
 *
 * No image URL, bucket path or upload object is read or returned: the reference images are
 * stored privately and this architecture has no signed-URL capability, so the alert points the
 * admin at the dashboard instead (docs/OPERATOR_RUNBOOK.md).
 */
export interface ProductRequest {
  id: string;
  reference: string | null;
  customerName: string | null;
  phone: string | null;
  productType: string | null;
  size: string | null;
  quantity: number | null;
  description: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface ProductRequestPage {
  requests: ProductRequest[];
  total: number;
  skipped: number;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const badResponse = (): never => { throw new AppError('INVALID_RESPONSE'); };

/** Accepts a usable identifier only; used for the idempotency key. */
const identifier = (value: unknown): string | null =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    && /^[A-Za-z0-9:_-]{1,240}$/.test(String(value)) ? String(value) : null;

const optionalText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value)
    ? value.trim() : null;

const optionalCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;

const firstText = (row: Record<string, unknown>, keys: string[], max: number): string | null => {
  for (const key of keys) {
    const found = optionalText(row[key], max);
    if (found) return found;
  }
  return null;
};

function parseRequest(value: unknown): ProductRequest | null {
  const r = record(value);
  const reference = firstText(r, ['reference', 'reference_code', 'referenceCode', 'request_code', 'code'], 80);
  const id = identifier(r['id']) ?? identifier(reference);
  if (!id) return null;
  return {
    id,
    reference: reference ?? (identifier(r['id']) ? null : id),
    customerName: firstText(r, ['customer_name', 'customerName', 'full_name', 'fullName', 'name'], 120),
    phone: firstText(r, ['phone', 'phone_number', 'phoneNumber', 'contact', 'whatsapp'], 40),
    productType: firstText(r, ['product_type', 'productType', 'category', 'item_type'], 120),
    size: firstText(r, ['size'], 40),
    quantity: optionalCount(r['quantity']),
    description: firstText(r, ['description', 'details', 'notes'], 1000),
    status: firstText(r, ['status', 'state'], 40),
    createdAt: optionalText(r['created_at'] ?? r['createdAt'], 40),
  };
}

export function parseProductRequestPage(value: unknown): ProductRequestPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badResponse();
  const body = value as Record<string, unknown>;
  // Accept the documented `items` envelope and a bare array; anything else is a shape failure.
  const rows = Array.isArray(body['items']) ? body['items']
    : Array.isArray(value) ? (value as unknown[])
    : null;
  if (!rows) return badResponse();
  const requests: ProductRequest[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const parsed = parseRequest(raw);
    if (parsed) requests.push(parsed); else skipped += 1;
  }
  const total = typeof body['total'] === 'number' && Number.isSafeInteger(body['total']) && body['total'] >= 0
    ? body['total'] : requests.length;
  return { requests, total, skipped };
}
