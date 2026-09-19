import { AppError } from '../integrations/alveron/errors.js';

/**
 * Deterministic run identity for the scheduled referral workflow.
 *
 * Why a window rather than one constant key: the ledger must suppress duplicate executions of the
 * SAME scheduled run (n8n retry, accidental replay, concurrent duplicate) WITHOUT suppressing the
 * NEXT legitimate run. The window derives from the wall clock and the configured interval, so it is
 * identical for every caller inside the same window and different in the next one.
 *
 * It encodes nothing about Alveron's referral state — the ledger records only "this automation
 * invocation happened", never referral or credit state.
 */
export interface ReferralWindow {
  windowId: string;
  executionKey: string;
}

export function computeReferralWindow(now: number, windowMinutes: number): ReferralWindow {
  if (!Number.isFinite(now) || now < 0 || !Number.isInteger(windowMinutes)
      || windowMinutes < 5 || windowMinutes > 1440) {
    throw new AppError('CONFIG_INVALID');
  }
  const sizeMs = windowMinutes * 60_000;
  const windowStart = Math.floor(now / sizeMs) * sizeMs;
  const windowId = `${new Date(windowStart).toISOString().slice(0, 16)}Z`;
  return { windowId, executionKey: `referral-qualification:${windowId}` };
}