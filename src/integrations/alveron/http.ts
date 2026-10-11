import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { FINANCE_EVENTS_PATH, FINANCE_READ_PATHS } from './finance.js';
import { AUTOMATION_EVENTS_PATH } from './automation-events.js';
import type { Logger } from './logger.js';

export interface Timing { now(): number; sleep(ms: number): Promise<void>; }
const realTiming: Timing = { now: Date.now, sleep: async (ms) => { await delay(ms); } };

/** Login, initial GETs and retries share the process-wide scheduler by default. */
export class RequestScheduler {
  private tail: Promise<unknown> = Promise.resolve();
  private starts: number[] = [];
  private logins: number[] = [];
  private lastStart = -Infinity;
  constructor(private readonly timing: Timing = realTiming) {}
  run<T>(limit: number, login: boolean, operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      const boundedLimit = Math.max(1, Math.min(limit, 40));
      const now = this.timing.now();
      this.starts = this.starts.filter((time) => now - time < 60000);
      this.logins = this.logins.filter((time) => now - time < 60000);
      const wait = Math.max(0, this.lastStart + Math.max(1500, 60000 / boundedLimit) - now,
        this.starts.length >= boundedLimit ? this.starts[0]! + 60000 - now : 0,
        login && this.logins.length >= 5 ? this.logins[0]! + 60000 - now : 0);
      if (wait > 0) await this.timing.sleep(wait);
      this.lastStart = this.timing.now();
      this.starts.push(this.lastStart);
      if (login) this.logins.push(this.lastStart);
      return operation();
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  sleep(ms: number): Promise<void> { return this.timing.sleep(ms); }
}
const sharedScheduler = new RequestScheduler();
const retryStatuses = new Set([429, 500, 502, 503, 504]);
const maxBodyBytes = 1024 * 1024;
type AttemptResult = { ok: true; value: unknown } |
  { ok: false; error: AppError; retry: boolean; retryAfterMs: number };

/**
 * Exact-path allowlist entry for read endpoints that require numeric pagination.
 * The base path must match exactly and every query value must be 1-4 digits, so no
 * caller-supplied host, path, key or value can ever reach the outbound request.
 */
function isPagedRead(path: string, base: string, keys: readonly string[], maxDigits = 4): boolean {
  const separator = path.indexOf('?');
  if (separator === -1) return path === base;
  if (path.slice(0, separator) !== base) return false;
  const query = path.slice(separator + 1);
  if (!query || query.length > 40) return false;
  const pairs = query.split('&');
  if (pairs.length > keys.length) return false;
  return pairs.every(pair => {
    const equals = pair.indexOf('=');
    if (equals <= 0) return false;
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    return keys.includes(key) && new RegExp(`^\\d{1,${maxDigits}}$`).test(value);
  });
}

/**
 * Outbox reads (finance + automation). The base path is exact; the only permitted query is a
 * bounded `status=pending|delivered`, `page`, `pageSize` pagination triple. No caller value can
 * introduce a host, path or arbitrary parameter.
 */
function isOutboxEventsRead(path: string, base: string): boolean {
  const separator = path.indexOf('?');
  if (separator === -1) return path === base;
  if (path.slice(0, separator) !== base) return false;
  const query = path.slice(separator + 1);
  if (!query || query.length > 60) return false;
  const pairs = query.split('&');
  if (pairs.length > 3) return false;
  const seen = new Set<string>();
  return pairs.every(pair => {
    const equals = pair.indexOf('=');
    if (equals <= 0) return false;
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === 'status') return value === 'pending' || value === 'delivered';
    if (key === 'page' || key === 'pageSize') return /^\d{1,4}$/.test(value);
    return false;
  });
}

/**
 * The non-financial writes the transport permits: acknowledge a single outbox event by UUID. Each
 * carries no body and can only flip that event's outbox row to `delivered` in Alveron.
 */
const FINANCE_EVENT_ACK_PATH =
  /^\/admin\/finance\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ack$/i;
const AUTOMATION_EVENT_ACK_PATH =
  /^\/admin\/automation\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ack$/i;

export class HttpTransport {
  private readonly baseUrl: string;
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly scheduler: RequestScheduler = sharedScheduler,
  ) {
    this.baseUrl = config.baseUrl;
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000 ||
        !Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3 ||
        !Number.isInteger(config.requestsPerMinute) || config.requestsPerMinute < 1 || config.requestsPerMinute > 40) {
      throw new AppError('CONFIG_INVALID');
    }
  }

  async request(method: 'GET' | 'POST', path: string, token?: string): Promise<unknown> {
    const login = method === 'POST' && path === '/auth/admin-login';
    const ack = method === 'POST' && (FINANCE_EVENT_ACK_PATH.test(path) || AUTOMATION_EVENT_ACK_PATH.test(path));
    // Exact-match allowlist: no wildcards, no query strings, no caller-supplied URLs.
    const allowedGet = /^\/orders(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(path)
      || isPagedRead(path, '/orders', ['limit', 'offset'], 6) // bounded order pagination only
      || path === '/referrals/admin/stats' // confirmed to invoke processPendingReferrals()
      || isPagedRead(path, '/products', ['limit', 'offset'])
      || isPagedRead(path, '/admin/product-requests', ['page', 'pageSize'])
      || isOutboxEventsRead(path, FINANCE_EVENTS_PATH) // bounded finance outbox pagination only
      || isOutboxEventsRead(path, AUTOMATION_EVENTS_PATH) // bounded automation outbox pagination only
      || FINANCE_READ_PATHS.includes(path); // exact, query-free finance reads only
    if (!login && !ack && !(method === 'GET' && allowedGet)) {
      throw new AppError('VALIDATION_FAILED');
    }
    const attempts = login ? 1 : this.config.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await this.scheduler.run(this.config.requestsPerMinute, login, () => this.attempt(method, path, token));
      if (result.ok) return result.value;
      this.logger.log('http_failure', { code: result.error.code, httpStatus: result.error.httpStatus, attempt: attempt + 1 });
      if (!result.retry || attempt + 1 >= attempts) throw result.error;
      this.logger.log('http_retry', { attempt: attempt + 1 });
      await this.scheduler.sleep(Math.max(result.retryAfterMs, Math.min(1000 * 2 ** attempt, 8000)));
    }
    throw new AppError('ALVERON_API_FAILURE');
  }

  private async attempt(method: 'GET' | 'POST', path: string, token?: string): Promise<AttemptResult> {
    const login = method === 'POST' && path === '/auth/admin-login';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error()); }, this.config.timeoutMs);
    });
    try {
      this.logger.log('http_attempt', { method });
      const task = async (): Promise<AttemptResult> => {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method, redirect: 'error', signal: controller.signal,
          headers: login ? { 'content-type': 'application/json', accept: 'application/json' } :
            { authorization: `Bearer ${token ?? ''}`, accept: 'application/json' },
          ...(login ? { body: JSON.stringify({ email: this.config.serviceEmail, password: this.config.servicePassword }) } : {}),
        });
        if (!response.ok) return failureResponse(response, login);
        return { ok: true, value: await readJson(response) };
      };
      return await Promise.race([task(), timeout]);
    } catch (error) {
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      // Preserve a specific AppError code (e.g. INVALID_RESPONSE); otherwise this is a
      // transport-level failure. Retryability is deliberately unchanged from Phase 4.
      const failure = error instanceof AppError ? error
        : new AppError(login ? 'AUTHENTICATION_FAILED' : 'NETWORK_ERROR');
      return { ok: false, error: failure, retry: !login && !(error instanceof AppError), retryAfterMs: 0 };
    } finally { if (timer) clearTimeout(timer); }
  }
}


function failureResponse(response: Response, login: boolean): AttemptResult {
  const status = response.status;
  const raw = response.headers.get('retry-after');
  const retryAfterMs = raw === null ? 0 : /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  const bounded = Number.isFinite(retryAfterMs) && retryAfterMs <= 60000;
  void response.body?.cancel().catch(() => undefined);
  const code = login || status === 401 ? 'AUTHENTICATION_FAILED'
    : status === 403 ? 'AUTHORIZATION_ERROR'
      : status === 429 ? 'RATE_LIMITED' : 'ALVERON_API_FAILURE';
  return { ok: false,
    error: new AppError(code, status),
    retry: !login && retryStatuses.has(status) && (raw === null || bounded), retryAfterMs: Math.max(0, retryAfterMs || 0) };
}

async function readJson(response: Response): Promise<unknown> {
  // Malformed/short/unexpected bodies are terminal (never retried) and never become "no data".
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
      Number(response.headers.get('content-length')) > maxBodyBytes || !response.body) {
    throw new AppError('INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBodyBytes) throw new AppError('INVALID_RESPONSE');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new AppError('INVALID_RESPONSE'); }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
