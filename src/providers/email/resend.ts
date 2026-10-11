import { setTimeout as delay } from 'node:timers/promises';
import { validEmail, type ResendConfig } from '../../integrations/alveron/config.js';
import type { FailureCategory } from '../../integrations/alveron/errors.js';
import { NotificationNotSent, type DeliveryReceipt } from '../notification-delivery.js';
import type { EmailProvider, NotificationMessage } from './index.js';
import { renderTransactionalEmail, templateEyebrow, type TransactionalEmail } from './templates.js';

/**
 * How the provider classified a definite non-delivery. `retryable` means the request was rejected
 * by a transient condition and may succeed on a later run; `permanent` means retrying the same
 * message cannot succeed (bad credentials, invalid address, rejected payload).
 */
export type DeliveryFailure = 'retryable' | 'permanent';

/**
 * A definite non-delivery: Resend responded and did not accept a message, so no email is in flight.
 * Extends the existing `NotificationNotSent` so the current ledger/runner contract is preserved
 * (FAILED, bounded retry) while exposing why the send failed.
 */
export class EmailNotSent extends NotificationNotSent {
  constructor(public readonly failure: DeliveryFailure, public readonly httpStatus?: number, category?: FailureCategory) {
    super(category ?? EmailNotSent.categoryFor(failure, httpStatus));
    this.name = 'EmailNotSent';
  }

  private static categoryFor(failure: DeliveryFailure, httpStatus?: number): FailureCategory {
    if (failure === 'retryable') return httpStatus === 429 ? 'RATE_LIMITED' : 'NETWORK_ERROR';
    // A permanent rejection is a definite non-delivery. A 401/403 is a credential/authorisation
    // problem; anything else is a rejected payload/response, never a transient condition.
    if (httpStatus === 401) return 'AUTHENTICATION_ERROR';
    if (httpStatus === 403) return 'AUTHORIZATION_ERROR';
    return 'INVALID_RESPONSE';
  }
}

/**
 * An ambiguous outcome: the request may have been accepted before the connection failed (or a 2xx
 * response could not be read). It must never be auto-resent — the existing runner records it
 * `PENDING` for human reconciliation. Deliberately NOT a `NotificationNotSent`.
 */
export class EmailDeliveryAmbiguous extends Error {
  constructor() {
    super('EMAIL_DELIVERY_AMBIGUOUS');
    this.name = 'EmailDeliveryAmbiguous';
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const maxBodyBytes = 64 * 1024;

/**
 * Server-side Resend adapter behind the existing `EmailProvider` interface.
 *
 * - Never logs the API key, recipient, subject body or provider error text.
 * - Bounded request timeout and bounded retries for transient rejections.
 * - Classifies definite non-delivery (`EmailNotSent`) vs ambiguous delivery
 *   (`EmailDeliveryAmbiguous`) so the existing ledger/idempotency layer keeps its semantics.
 * - A malformed 2xx response is ambiguous, not success: the message may already be accepted.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly namespace = 'resend';
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = async (ms) => { await delay(ms); },
    private readonly maxRetries = 2,
  ) {}

  sendCustomerOrderConfirmation(message: NotificationMessage, _eventKey: string): Promise<DeliveryReceipt> {
    return this.send('Order confirmation', message.recipient, message.subject, message.text);
  }
  sendAdminOrderAlert(message: NotificationMessage, _eventKey: string): Promise<DeliveryReceipt> {
    return this.send('Admin alert', message.recipient, message.subject, message.text);
  }
  sendCustomerTransactional(email: TransactionalEmail, _eventKey: string): Promise<DeliveryReceipt> {
    return this.send(templateEyebrow[email.template], email.recipient, email.subject, email.text);
  }

  private async send(eyebrow: string, recipient: string, subject: string, text: string): Promise<DeliveryReceipt> {
    // Fail closed on missing/invalid configuration or recipient without touching the network.
    if (!this.config.apiKey || !validEmail(this.config.fromEmail)) {
      throw new EmailNotSent('permanent', undefined, 'CONFIGURATION_ERROR');
    }
    if (!validEmail(recipient)) throw new EmailNotSent('permanent');
    const payload = {
      from: this.fromHeader,
      to: [recipient],
      subject: subject.slice(0, 200),
      html: renderTransactionalEmail({ subject, text }, eyebrow),
      // Resend accepts a text fallback so the message is readable without HTML.
      text,
    };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const outcome = await this.attempt(payload);
      if (outcome.kind === 'sent') return { messageId: outcome.messageId, simulated: false };
      if (outcome.kind === 'permanent') throw new EmailNotSent('permanent', outcome.status);
      if (attempt >= this.maxRetries) throw new EmailNotSent('retryable', outcome.status);
      await this.sleep(Math.min(250 * 2 ** attempt, 4000));
    }
    // Unreachable: the loop either returns or throws. Kept for exhaustiveness.
    throw new EmailNotSent('retryable');
  }

  private get fromHeader(): string {
    const name = this.config.fromName.replace(/[<>,]/g, '').trim();
    return name ? `${name} <${this.config.fromEmail}>` : this.config.fromEmail;
  }

  private async attempt(payload: unknown):
  Promise<{ kind: 'sent'; messageId: string } | { kind: 'retryable' | 'permanent'; status: number }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error()); }, this.config.timeoutMs);
    });
    try {
      const response = await Promise.race([this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      }), timeout]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        // Never read or surface the provider's error body: it may echo the request or key context.
        return RETRYABLE_STATUS.has(response.status)
          ? { kind: 'retryable', status: response.status }
          : { kind: 'permanent', status: response.status };
      }
      const id = await readMessageId(response);
      // A 2xx without a usable id is an accepted-or-unknown outcome, never a confirmed send.
      if (!id) throw new EmailDeliveryAmbiguous();
      return { kind: 'sent', messageId: `resend:${id}` };
    } catch (error) {
      if (error instanceof EmailDeliveryAmbiguous || error instanceof EmailNotSent) throw error;
      // Timeout, abort, DNS/TLS/connection failure or an unreadable body: the message may have
      // been accepted, so the existing runner must leave it PENDING rather than risk a duplicate.
      throw new EmailDeliveryAmbiguous();
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function readMessageId(response: Response): Promise<string | null> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
      Number(response.headers.get('content-length')) > maxBodyBytes || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBodyBytes) return null;
      chunks.push(chunk.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const id = (parsed as Record<string, unknown>)['id'];
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
