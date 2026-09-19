import { randomUUID } from 'node:crypto';
import type { ReferralClient } from '../integrations/alveron/client.js';
import type { FailureCategory } from '../integrations/alveron/errors.js';
import type { ReferralStats } from '../integrations/alveron/schemas.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import { computeReferralWindow } from '../services/referral-qualification-window.js';
import { ReferralRunner, type ReferralDuplicateReason } from './referral-runner.js';

/** The only Alveron endpoint this workflow calls. Confirmed to invoke processPendingReferrals(). */
export const REFERRAL_ENDPOINT = '/referrals/admin/stats';

export interface ReferralQualificationResult {
  runId: string;
  workflow: 'referral-qualification';
  status: 'completed' | 'failed' | 'duplicate';
  endpoint: string;
  windowId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  httpSucceeded: boolean;
  sideEffectInvoked: boolean;
  /** Always null: Alveron does not report how many referrals were processed (see V5/V7 in the plan). */
  processedCount: null;
  observations?: ReferralStats;
  duplicate?: ReferralDuplicateReason;
  failureCategory?: FailureCategory;
  code?: string;
  ledgerRecorded?: boolean;
  message: string;
}

/**
 * Schedules a trigger of Alveron's OWN referral processing. No referral eligibility, reward, credit,
 * threshold, timing or status rule is evaluated here — Alveron remains the source of truth.
 */
export class ReferralQualificationWorkflow {
  constructor(
    private readonly client: ReferralClient,
    private readonly ledger: Ledger,
    private readonly windowMinutes: number,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<ReferralQualificationResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const window = computeReferralWindow(startedAtMs, this.windowMinutes);
    const outcome = await new ReferralRunner(this.ledger)
      .run(window, () => this.client.triggerReferralProcessing());
    const completedAtMs = this.now();
    const base = {
      runId, workflow: 'referral-qualification' as const, endpoint: REFERRAL_ENDPOINT,
      windowId: window.windowId, startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - startedAtMs), processedCount: null as null,
    };
    if (outcome.status === 'completed') {
      return { ...base, status: 'completed', httpSucceeded: true, sideEffectInvoked: true,
        observations: outcome.stats,
        message: 'Alveron referral processing invoked; the endpoint reports no processed count.' };
    }
    if (outcome.status === 'duplicate') {
      return { ...base, status: 'duplicate', httpSucceeded: false, sideEffectInvoked: false,
        duplicate: outcome.reason,
        message: 'This scheduled window was already handled; Alveron was not called again.' };
    }
    return { ...base, status: 'failed', httpSucceeded: false, sideEffectInvoked: false,
      failureCategory: outcome.category, code: outcome.code, ledgerRecorded: outcome.ledgerRecorded,
      message: 'Alveron referral processing was not confirmed; no success is claimed.' };
  }
}