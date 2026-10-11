import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NotificationNotSent } from './notification-delivery.js';
import {
  renderTelegramHtml,
  type AdminNotification,
  type AdminNotificationProvider,
} from './admin/index.js';

export interface TelegramTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realTiming: TelegramTiming = { now: Date.now, sleep: async (ms) => { await delay(ms); } };
const maxResponseBytes = 65536;
const maxRetryAfterMs = 120000;

class TelegramRateLimitError extends NotificationNotSent {
  constructor(readonly retryAfterMs: number) { super(); }
}

function retryAfter(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 1000;
  const result = payload as Record<string, unknown>;
  const parameters = result['parameters'];
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return 1000;
  const value = (parameters as Record<string, unknown>)['retry_after'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1000;
  const milliseconds = Math.ceil(value * 1000);
  return Number.isFinite(milliseconds) ? Math.min(maxRetryAfterMs, Math.max(1000, milliseconds)) : maxRetryAfterMs;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const cancel = async () => { await response.body?.cancel().catch(() => undefined); };
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    await cancel(); throw new Error();
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await cancel(); throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) throw new Error();
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

export class TelegramAdminNotificationProvider implements AdminNotificationProvider {
  readonly namespace: string;
  readonly enabled = true;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private starts: number[] = [];
  private cooldownUntil = 0;

  constructor(
    private readonly botToken: string,
    private readonly adminChatId: string,
    private readonly timeoutMs = 10000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timing: TelegramTiming = realTiming,
  ) {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(botToken) ||
        !/^(?:-?\d+|@[A-Za-z0-9_]{5,32})$/.test(adminChatId) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new NotificationNotSent();
    }
    const destinationHash = createHash('sha256')
      .update(`${botToken.split(':', 1)[0]}:${adminChatId}`)
      .digest('hex')
      .slice(0, 16);
    this.namespace = `telegram:${destinationHash}`;
  }

  send(notification: AdminNotification, _eventKey: string): Promise<{ messageId: string; simulated: boolean }> {
    if (this.queued >= 50) return Promise.reject(new NotificationNotSent());
    this.queued++;
    const work = this.queue.then(() => this.deliver(notification));
    this.queue = work.then(() => undefined, () => undefined);
    return work.finally(() => { this.queued--; });
  }

  private async reserveSlot(): Promise<void> {
    while (true) {
      const now = this.timing.now();
      this.starts = this.starts.filter(start => start > now - 60000);
      const onePerSecond = this.starts.length ? Math.max(0, this.starts.at(-1)! + 1100 - now) : 0;
      const perMinute = this.starts.length >= 20 ? Math.max(0, this.starts[0]! + 60000 - now) : 0;
      const cooldown = Math.max(0, this.cooldownUntil - now);
      const wait = Math.max(onePerSecond, perMinute, cooldown);
      if (!wait) return;
      await this.timing.sleep(wait);
    }
  }

  private async deliver(notification: AdminNotification) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.reserveSlot();
      this.starts.push(this.timing.now());
      try {
        const payload = await this.request(notification);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
        const result = payload as Record<string, unknown>;
        if (result['ok'] !== true) throw new Error();
        const message = result['result'];
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        const messageId = (message as Record<string, unknown>)['message_id'];
        if (!Number.isSafeInteger(messageId) || typeof messageId !== 'number') throw new Error();
        return { messageId: String(messageId), simulated: false };
      } catch (error) {
        if (error instanceof TelegramRateLimitError) {
          this.cooldownUntil = Math.max(this.cooldownUntil, this.timing.now() + error.retryAfterMs);
          if (attempt === 0 && error.retryAfterMs <= 30000) {
            await this.timing.sleep(error.retryAfterMs);
            continue;
          }
          throw new NotificationNotSent();
        }
        if (error instanceof NotificationNotSent) throw error;
        throw new Error();
      }
    }
    throw new NotificationNotSent();
  }

  private async request(notification: AdminNotification): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          chat_id: this.adminChatId,
          text: renderTelegramHtml(notification),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (response.status === 429) {
        let wait = 1000;
        try { wait = retryAfter(await readResponseJson(response)); }
        catch { await response.body?.cancel().catch(() => undefined); }
        throw new TelegramRateLimitError(wait);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status >= 400 && response.status < 500) throw new NotificationNotSent();
        throw new Error();
      }
      const payload = await readResponseJson(response);
      if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
          (payload as Record<string, unknown>)['ok'] === false) {
        const code = (payload as Record<string, unknown>)['error_code'];
        if (code === 429) throw new TelegramRateLimitError(retryAfter(payload));
        throw new NotificationNotSent();
      }
      return payload;
    } catch (error) {
      if (error instanceof TelegramRateLimitError || error instanceof NotificationNotSent) throw error;
      throw new Error();
    } finally { clearTimeout(timeout); }
  }
}
