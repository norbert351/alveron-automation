import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { assertLoopbackBase } from './config.js';
import { AppError } from './errors.js';
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

export class HttpTransport {
  private readonly baseUrl: string;
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly scheduler: RequestScheduler = sharedScheduler,
  ) {
    this.baseUrl = assertLoopbackBase(config.baseUrl);
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000 ||
        !Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3 ||
        !Number.isInteger(config.requestsPerMinute) || config.requestsPerMinute < 1 || config.requestsPerMinute > 40) {
      throw new AppError('CONFIG_INVALID');
    }
  }

  async request(method: 'GET' | 'POST', path: string, token?: string): Promise<unknown> {
    const login = method === 'POST' && path === '/auth/admin-login';
    // Exact-match allowlist: no wildcards, no query strings, no caller-supplied URLs.
    const allowedGet = /^\/orders(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(path)
      || path === '/referrals/admin/stats'; // confirmed to invoke processPendingReferrals()
    if (!login && !(method === 'GET' && allowedGet)) {
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
    const login = method === 'POST';
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
