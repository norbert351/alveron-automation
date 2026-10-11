import { AppError } from './errors.js';

/**
 * Low-stock detection inputs. Read-only projection of `GET /products`.
 *
 * Only fields required to decide "this variant is at or below its product's low-stock
 * threshold" are retained. Prices, images, descriptions and merchandising data are
 * deliberately not read: an admin alert must never carry data the dashboard already owns.
 *
 * The response envelope is validated strictly (an unexpected shape is a failure, never
 * "zero low-stock items"). Individual products that do not parse are skipped and counted
 * so a single malformed row cannot silently blind every low-stock alert.
 */
export interface CatalogVariant {
  id: string;
  stock: number | null;
  color: string | null;
  size: string | null;
}

export interface CatalogProduct {
  id: string;
  title: string;
  trackInventory: boolean;
  lowStockAlert: number | null;
  variants: CatalogVariant[];
}

export interface ProductCatalogPage {
  products: CatalogProduct[];
  total: number;
  skipped: number;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const badResponse = (): never => { throw new AppError('INVALID_RESPONSE'); };

const identifier = (value: unknown): string | null =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    && /^[A-Za-z0-9:_-]{1,240}$/.test(String(value)) ? String(value) : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const label = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\0\r\n]/.test(value)
    ? value.trim() : null;

function parseVariant(value: unknown): CatalogVariant | null {
  const v = record(value);
  const id = identifier(v['id']);
  if (!id) return null;
  const stock = count(v['stock']);
  return {
    id,
    stock: v['stock'] === null || v['stock'] === undefined ? null : stock,
    color: label(v['color']),
    size: label(v['size']),
  };
}

function parseProduct(value: unknown): CatalogProduct | null {
  const p = record(value);
  const id = identifier(p['id']);
  const title = label(p['title']);
  // `variants` must be an array to reason about stock at all; a product without one is skipped.
  if (!id || !title || !Array.isArray(p['variants'])) return null;
  const variants = p['variants'].map(parseVariant).filter((v): v is CatalogVariant => v !== null);
  return {
    id, title,
    trackInventory: p['track_inventory'] === true,
    lowStockAlert: count(p['low_stock_alert']),
    variants,
  };
}

export function parseProductCatalog(value: unknown): ProductCatalogPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badResponse();
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body['items'])) return badResponse();
  const products: CatalogProduct[] = [];
  let skipped = 0;
  for (const raw of body['items'] as unknown[]) {
    const product = parseProduct(raw);
    if (product) products.push(product); else skipped += 1;
  }
  const total = count(body['total']);
  return { products, total: total ?? products.length, skipped };
}
