import { AppError } from './errors.js';

/**
 * Alveron automation outbox (`automation_events`), served at `/api/admin/automation/events`.
 *
 * Alveron writes a row as a best-effort side effect of a business action; this automation polls
 * the authenticated endpoint, maps known events to notifications, and acknowledges each one. n8n
 * never touches the database and never receives a service-role credential. The read is static
 * except for the bounded `status`/`page`/`pageSize` query; acknowledgement is the ONE typed,
 * non-financial POST the transport permits (it only flips an outbox row to `delivered`).
 */
export const AUTOMATION_EVENTS_PATH = '/admin/automation/events';

export const AUTOMATION_ACTIVE_EVENT_TYPES = [
  'product_request_created',
  'product_request_status_changed',
  'order_issue_created',
  'order_issue_customer_contacted',
  'order_issue_alternative_offered',
  'order_issue_resolved',
] as const;

export type AutomationEventType = (typeof AUTOMATION_ACTIVE_EVENT_TYPES)[number];
const activeEventTypes = new Set<string>(AUTOMATION_ACTIVE_EVENT_TYPES);
export const isKnownAutomationEventType = (eventType: string): eventType is AutomationEventType =>
  activeEventTypes.has(eventType);

export interface AutomationEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered';
  idempotencyKey: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface AutomationEventPage {
  items: AutomationEvent[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badResponse = (): never => { throw new AppError('INVALID_RESPONSE'); };
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : badResponse();

const requiredText = (value: unknown, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) return badResponse();
  return value.trim();
};

const optionalIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = requiredText(value, 40);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : badResponse();
};

const count = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return badResponse();
  return value;
};

function parseAutomationEvent(value: unknown): AutomationEvent {
  const event = record(value);
  const status = requiredText(event['status'], 20);
  if (status !== 'pending' && status !== 'delivered') return badResponse();
  const eventType = requiredText(event['event_type'], 64);
  if (!/^[a-z0-9_]{1,64}$/.test(eventType)) return badResponse();
  const idempotency = event['idempotency_key'];
  return {
    id: requiredText(event['id'], 64),
    eventType,
    payload: event['payload'] === null || event['payload'] === undefined ? {} : record(event['payload']),
    status,
    idempotencyKey: idempotency === null || idempotency === undefined ? null
      : requiredText(idempotency, 240),
    createdAt: optionalIso(event['created_at']) ?? badResponse(),
    deliveredAt: optionalIso(event['delivered_at']),
  };
}

/** Strict outbox page. A malformed page fails whole; the workflow never fabricates an event. */
export function parseAutomationEventPage(value: unknown): AutomationEventPage {
  const body = record(value);
  if (!Array.isArray(body['items'])) return badResponse();
  const items = body['items'].map(parseAutomationEvent);
  const page = count(body['page']);
  const pageSize = count(body['pageSize']);
  const pages = count(body['pages']);
  if (page === null || pageSize === null || pageSize < 1 || pages === null) return badResponse();
  return { items, total: count(body['total']) ?? items.length, page, pageSize, pages };
}

/** Acknowledgement receipt. Confirms Alveron actually flipped the row to `delivered`. */
export function parseAutomationEventAck(value: unknown): { id: string; status: 'delivered' } {
  const body = record(value);
  const status = requiredText(body['status'], 20);
  if (status !== 'delivered') return badResponse();
  return { id: requiredText(body['id'], 64), status };
}

/** Payload field helpers for the typed event handlers. Absent is null, never a guess. */
export const eventText = (payload: Record<string, unknown>, key: string, max = 300): string | null => {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  return requiredText(value, max);
};
export const eventCount = (payload: Record<string, unknown>, key: string): number | null =>
  count(payload[key]);
export const eventUuid = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || !uuidPattern.test(value)) return badResponse();
  return value.toLowerCase();
};
