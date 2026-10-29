import { randomUUID } from 'node:crypto';
import type { ReferralClient } from '../integrations/alveron/client.js';
import type { FailureCategory } from '../integrations/alveron/errors.js';
import type { ReferralStats } from '../integrations/alveron/schemas.js';
import type { Ledger } from '../ledger/sqlite-ledger.js';
import { computeReferralWindow } from '../services/referral-qualification-window.js';
import {
  disabledAdminNotifier,
  referralProcessingFailureNotification,
  referralRewardIssueNotification,
  referralRewardNotification,
  type AdminNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';
import { ReferralRunner, type ReferralDuplicateReason } from './referral-runner.js';

/** The only Alveron endpoint this workflow calls. Confirmed to invoke processPendingReferrals(). */
export const REFERRAL_ENDPOINT = '/referrals/admin/stats';

/** Durable observation state, stored in the same SQLite file as the notification ledger. */
export const REFERRAL_SNAPSHOT_KEY = 'referral-qualification:last-observed-stats';

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
  adminNotificationStatus?: AdminNotificationResult['status'];
  message: string;
}

interface ReferralSnapshot {
  total: number;
  pending: number;
  qualified: number;
  rewarded: number;
  cancelled: number;
  totalRewards: number;
}

function snapshotOf(stats: ReferralStats): ReferralSnapshot {
  return {
    total: stats.total, pending: stats.pending, qualified: stats.qualified,
    rewarded: stats.rewarded, cancelled: stats.cancelled, totalRewards: stats.totalRewards,
  };
}

function readSnapshot(ledger: Ledger): ReferralSnapshot | null {
  const raw = ledger.getState(REFERRAL_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const field = (name: keyof ReferralSnapshot): number => {
      const candidate = value[name];
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new Error('invalid snapshot');
      }
      return candidate;
    };
    return {
      total: field('total'), pending: field('pending'), qualified: field('qualified'),
      rewarded: field('rewarded'), cancelled: field('cancelled'), totalRewards: field('totalRewards'),
    };
  } catch {
    // A corrupt snapshot must never fabricate a reward. Treat it as a new baseline.
    return null;
  }
}

/**
 * Schedules a trigger of Alveron's OWN referral processing. No referral eligibility, reward, credit,
 * threshold, timing or status rule is evaluated here — Alveron remains the source of truth.
 *
 * Notifications are deliberately event-based rather than run-based: Alveron exposes only aggregate
 * stats, so this workflow remembers the last observed aggregates durably and alerts only when the
 * rewarded total increases. A run with no new reward sends nothing.
 */
export class ReferralQualificationWorkflow {
  constructor(
    private readonly client: ReferralClient,
    private readonly ledger: Ledger,
    private readonly windowMinutes: number,
    private readonly now: () => number = Date.now,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
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
      const observation = await this.observeRewards(outcome.stats, completedAtMs);
      return { ...base, status: 'completed', httpSucceeded: true, sideEffectInvoked: true,
        observations: outcome.stats,
        ...(observation.status ? { adminNotificationStatus: observation.status } : {}),
        message: observation.message };
    }
    if (outcome.status === 'duplicate') {
      if (outcome.reason === 'ATTEMPTS_EXHAUSTED') {
        const entry = this.ledger.get(window.executionKey);
        const status = await this.notify(referralProcessingFailureNotification({
          windowId: window.windowId,
          category: entry?.last_category ?? 'UNKNOWN_ERROR',
          code: entry?.last_error ?? 'UNKNOWN_ERROR',
          observedAt: new Date(completedAtMs).toISOString(),
        }));
        return { ...base, status: 'duplicate', httpSucceeded: false, sideEffectInvoked: false,
          duplicate: outcome.reason,
          ...(status ? { adminNotificationStatus: status } : {}),
          message: 'This window exhausted its retries; a failure alert was recorded.' };
      }
      return { ...base, status: 'duplicate', httpSucceeded: false, sideEffectInvoked: false,
        duplicate: outcome.reason,
        message: 'This scheduled window was already handled; Alveron was not called again.' };
    }
    return { ...base, status: 'failed', httpSucceeded: false, sideEffectInvoked: false,
      failureCategory: outcome.category, code: outcome.code, ledgerRecorded: outcome.ledgerRecorded,
      message: 'Alveron referral processing was not confirmed; no success is claimed.' };
  }

  /**
   * Compares the current aggregates with the last persisted observation and emits exactly one
   * notification for the observed reward state. The snapshot is advanced only after the notification
   * is delivered (or the channel is disabled/already deduplicated), so a failed send is retried on
   * the next run without ever re-alerting for a reward state that was already delivered.
   */
  private async observeRewards(
    stats: ReferralStats,
    observedAtMs: number,
  ): Promise<{ status?: AdminNotificationResult['status']; message: string }> {
    const current = snapshotOf(stats);
    const previous = readSnapshot(this.ledger);
    if (!previous) {
      this.saveSnapshot(current);
      return { message: 'Referral processing invoked; baseline aggregates recorded for future reward alerts.' };
    }
    const rewardedDelta = current.rewarded - previous.rewarded;
    const qualifiedDelta = current.qualified - previous.qualified;
    const observedAt = new Date(observedAtMs).toISOString();

    // `rewarded` is the only trustworthy issuance signal. `totalRewards` is set when a referral is
    // attributed at checkout (before qualification), so its delta can never prove that a reward
    // was issued. Per-reward amounts are not exposed by the aggregate stats endpoint.
    if (rewardedDelta > 0) {
      const reference = `reward-batch:${previous.rewarded}-${current.rewarded}`;
      const status = await this.notify(referralRewardNotification({
        reference,
        newlyRewarded: rewardedDelta,
        rewardAmount: null,
        rewardedTotal: current.rewarded,
        qualifiedTotal: current.qualified,
        observedAt,
      }));
      if (this.delivered(status)) this.saveSnapshot(current);
      return {
        ...(status ? { status } : {}),
        message: 'A referral reward increase was observed; the success notification outcome is recorded.',
      };
    }

    if (qualifiedDelta > 0) {
      const reference = `reward-issue:${previous.qualified}-${current.qualified}:${current.rewarded}`;
      const status = await this.notify(referralRewardIssueNotification({
        reference,
        newlyQualified: qualifiedDelta,
        newlyRewarded: 0,
        rewardedTotal: current.rewarded,
        qualifiedTotal: current.qualified,
        observedAt,
      }));
      if (this.delivered(status)) this.saveSnapshot(current);
      return {
        ...(status ? { status } : {}),
        message: 'Qualified referrals increased without a reported reward increase; a warning was recorded.',
      };
    }

    this.saveSnapshot(current);
    if (rewardedDelta < 0) {
      return { message: 'The rewarded aggregate decreased; the new baseline was recorded without a reward alert.' };
    }
    return { message: 'Referral processing completed; no new reward was observed.' };
  }

  private delivered(status: AdminNotificationResult['status'] | undefined): boolean {
    return status === 'SUCCESS' || status === 'SKIPPED' || status === 'DISABLED';
  }

  private async notify(notification: AdminNotification): Promise<AdminNotificationResult['status']> {
    try { return (await this.adminNotifications.notify(notification)).status; }
    catch { return 'FAILED'; }
  }

  private saveSnapshot(snapshot: ReferralSnapshot): void {
    this.ledger.setState(REFERRAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  }
}
