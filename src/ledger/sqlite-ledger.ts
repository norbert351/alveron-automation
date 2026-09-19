import { AppError } from '../integrations/alveron/errors.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface Claim {
  key: string;
  owner: string;
}
export interface LedgerEntry {
  key: string;
  order_id: string;
  event_type: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  provider_message_id: string | null;
}
export interface Ledger {
  claim(key: string, resourceId: string, eventType: string): Claim | null;
  markSuccess(claim: Claim, messageId?: string): void;
  markFailure(claim: Claim, reason?: string): void;
  get(key: string): LedgerEntry | null;
  has(key: string): boolean;
}

/** Automation-local persistence only. Never connects to Alveron's database. */
export class SqliteLedger implements Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly maxAttempts = 3) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS notification_ledger (
        key TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCESS','FAILED')),
        owner TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        provider_message_id TEXT
      );
    `);
  }

  claim(key: string, resourceId: string, eventType: string): Claim | null {
    const owner = randomUUID();
    const now = new Date().toISOString();
    // One SQL statement is the concurrency boundary, not check-then-insert.
    const result = this.db.prepare(`
      INSERT INTO notification_ledger
        (key,order_id,event_type,status,owner,attempts,created_at,updated_at)
      VALUES (?,?,?,'PENDING',?,1,?,?)
      ON CONFLICT(key) DO UPDATE SET
        status='PENDING', owner=excluded.owner,
        attempts=notification_ledger.attempts+1,
        updated_at=excluded.updated_at, last_error=NULL
      WHERE notification_ledger.status='FAILED'
        AND notification_ledger.attempts < ?
        AND notification_ledger.order_id=excluded.order_id
        AND notification_ledger.event_type=excluded.event_type
    `).run(key, resourceId, eventType, owner, now, now, this.maxAttempts);
    return result.changes === 1 ? { key, owner } : null;
  }

  markSuccess(claim: Claim, messageId?: string): void {
    this.finish(claim, 'SUCCESS', messageId ?? null, null);
  }

  /** Only for definite non-delivery. Ambiguous sends must remain PENDING. */
  markFailure(claim: Claim, reason = 'NOTIFICATION_NOT_SENT'): void {
    const allowed = ['NOTIFICATION_NOT_SENT', 'VALIDATION_FAILED', 'CUSTOMER_EMAIL_MISSING',
      'ALVERON_API_FAILURE', 'AUTHENTICATION_FAILED', 'RATE_LIMITED',
      'NETWORK_ERROR', 'INVALID_RESPONSE', 'AUTHORIZATION_ERROR'];
    this.finish(claim, 'FAILED', null, allowed.includes(reason) ? reason : 'INTERNAL_ERROR');
  }

  private finish(claim: Claim, status: string, messageId: string | null, reason: string | null): void {
    const result = this.db.prepare(`
      UPDATE notification_ledger SET status=?, provider_message_id=?,
        last_error=?, updated_at=?
      WHERE key=? AND owner=? AND status='PENDING'
    `).run(status, messageId, reason, new Date().toISOString(), claim.key, claim.owner);
    if (result.changes !== 1) throw new AppError('LEDGER_FAILURE');
  }

  get(key: string): LedgerEntry | null {
    const row = this.db.prepare(`SELECT key,order_id,event_type,status,attempts,
      created_at,updated_at,last_error,provider_message_id
      FROM notification_ledger WHERE key=?`).get(key);
    return row ? row as unknown as LedgerEntry : null;
  }

  has(key: string): boolean { return this.get(key)?.status === 'SUCCESS'; }
  close(): void { this.db.close(); }
}
