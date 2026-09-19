import { classifyFailure, safeCode, type FailureCategory } from '../integrations/alveron/errors.js';
import type { ReferralStats } from '../integrations/alveron/schemas.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import type { ReferralWindow } from '../services/referral-qualification-window.js';

export type ReferralDuplicateReason = 'ALREADY_COMPLETED' | 'ALREADY_RUNNING' | 'ATTEMPTS_EXHAUSTED';

export type ReferralRunResult =
  | { status: 'completed'; stats: ReferralStats }
  | { status: 'duplicate'; reason: ReferralDuplicateReason }
  | { status: 'failed'; category: FailureCategory; code: string; ledgerRecorded: boolean };

/**
 * Runs exactly one claimed referral-qualification execution.
 *
 * Concurrency boundary: the atomic ledger claim (a single conditional SQL upsert keyed on the
 * window) — NOT an in-process flag and NOT a distributed lock, so a second gateway process gets
 * the same guarantee.
 *
 * Unlike outbound notifications, a duplicate *invocation* is safe here: Alveron's own processing is
 * idempotent (app-level check plus a unique partial index on credit_transactions.referral_id), so a
 * failed run may be retried inside the same window.
 */
export class ReferralRunner {
  constructor(private readonly ledger: Ledger) {}

  async run(window: ReferralWindow, invoke: () => Promise<ReferralStats>): Promise<ReferralRunResult> {
    const claim = this.ledger.claim(window.executionKey, window.windowId, 'referral-qualification');
    if (!claim) return { status: 'duplicate', reason: this.duplicateReason(window.executionKey) };
    try {
      const stats = await invoke();
      this.ledger.markSuccess(claim);
      return { status: 'completed', stats };
    } catch (error) {
      // Never report success when Alveron failed. A definite failure is recorded as FAILED so a
      // later call in the same window may retry within the bounded attempt limit.
      let ledgerRecorded = true;
      try { this.ledger.markFailure(claim, safeCode(error)); } catch { ledgerRecorded = false; }
      return { status: 'failed', category: classifyFailure(error), code: safeCode(error), ledgerRecorded };
    }
  }

  private duplicateReason(key: string): ReferralDuplicateReason {
    const entry = this.ledger.get(key);
    if (!entry) return 'ALREADY_RUNNING';
    if (entry.status === 'SUCCESS') return 'ALREADY_COMPLETED';
    if (entry.status === 'PENDING') return 'ALREADY_RUNNING';
    return 'ATTEMPTS_EXHAUSTED';
  }
}