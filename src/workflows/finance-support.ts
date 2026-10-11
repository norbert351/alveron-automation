import { randomUUID } from 'node:crypto';
import { classifyFailure, safeCode, type FailureCategory } from '../integrations/alveron/errors.js';
import {
  disabledAdminNotifier,
  financeUnavailableNotification,
  type AdminNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** Uniform result envelope for every finance workflow, so n8n validation stays identical. */
export interface FinanceWorkflowResult {
  runId: string;
  workflow: string;
  status: 'completed' | 'failed' | 'busy' | 'noop';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  itemsFound: number;
  notified: number;
  duplicates: number;
  suppressedByCap: number;
  /** Outbox events acknowledged (delivered) in this run. Always 0 for polling workflows. */
  acked: number;
  /** Outbox events read but deliberately left pending (notification failed, disabled, or unknown). */
  unacked: number;
  /** Outbox events whose type is not part of the served contract. */
  unhandled: number;
  notificationStatus: AdminNotificationResult['status'];
  code?: string;
  failureCategory?: FailureCategory;
  message: string;
}

type FinanceOverrides = Partial<Pick<FinanceWorkflowResult,
  'itemsFound' | 'notified' | 'duplicates' | 'suppressedByCap' | 'acked' | 'unacked' | 'unhandled' |
  'notificationStatus' | 'code' | 'failureCategory'>>;

export function createFinanceRun(workflow: string, endpoint: string, now: () => number) {
  const runId = randomUUID();
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const finish = (over: { status: FinanceWorkflowResult['status']; message: string } & FinanceOverrides): FinanceWorkflowResult => {
    const completedAtMs = now();
    return {
      runId, workflow, endpoint, startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      itemsFound: 0, notified: 0, duplicates: 0, suppressedByCap: 0, acked: 0, unacked: 0, unhandled: 0,
      notificationStatus: 'DISABLED', ...over,
    };
  };
  return { runId, finish };
}

/** Sends one admin notification, isolating a provider failure from the workflow outcome. */
export async function safeNotify(notifications: AdminNotifier, notification: AdminNotification): Promise<AdminNotificationResult['status']> {
  try { return (await notifications.notify(notification)).status; }
  catch { return 'FAILED'; }
}

/**
 * Reports a finance-retrieval failure. Alveron remains the source of truth; the notification is a
 * CRITICAL automation-health alert, not a financial statement.
 */
export async function notifyFinanceFailure(
  notifications: AdminNotifier,
  workflow: string,
  error: unknown,
): Promise<{ notificationStatus: AdminNotificationResult['status']; code: string; failureCategory: FailureCategory }> {
  const code = safeCode(error);
  const failureCategory = classifyFailure(error);
  const status = await safeNotify(notifications, financeUnavailableNotification(workflow, code));
  return { notificationStatus: status, code, failureCategory };
}

/** Tally a single notification outcome. */
export function tally(status: AdminNotificationResult['status']): { notified: number; duplicates: number } {
  if (status === 'SUCCESS') return { notified: 1, duplicates: 0 };
  if (status === 'SKIPPED') return { notified: 0, duplicates: 1 };
  return { notified: 0, duplicates: 0 };
}

export { disabledAdminNotifier };
