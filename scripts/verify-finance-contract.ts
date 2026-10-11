/**
 * SAFE READ-ONLY live finance contract verification.
 *
 * Reads each served finance contract endpoint (and the outbox) with a real service-account session
 * and reports only non-sensitive shape information: HTTP outcome, top-level keys and item counts.
 * It NEVER prints amounts, references, customer data or account identifiers, and it performs no
 * mutation (the only permitted POST is an outbox ack, which this verification deliberately omits).
 */
import { loadConfig } from '../src/integrations/alveron/config.js';
import { makeClient } from '../src/gateway/application.js';
import { safeCode, type AppError } from '../src/integrations/alveron/errors.js';

const keys = (value: unknown): string[] =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as object).sort() : [];
const count = (value: unknown): number | null =>
  value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: unknown[] }).items.length : null;

try {
  const client = makeClient(loadConfig());
  const probes: Array<[string, () => Promise<unknown>]> = [
    ['overview', () => client.getFinanceOverview()],
    ['reports/daily', () => client.getFinanceDailyReport()],
    ['reports/weekly', () => client.getFinanceWeeklyReport()],
    ['reconciliation', () => client.getFinanceReconciliation()],
    ['expenses/pending-review', () => client.getPendingReviewExpenses()],
    ['supplier-payables', () => client.getSupplierPayables()],
    ['review-queue', () => client.getFinanceReviewQueue()],
    ['withdrawals', () => client.getOwnerWithdrawals()],
  ];
  const results: Record<string, unknown> = {};
  for (const [name, probe] of probes) {
    try {
      const value = await probe();
      results[name] = { outcome: 'ok', shape: keys(value), items: count(value) };
    } catch (error) {
      results[name] = { outcome: 'error', code: safeCode(error),
        httpStatus: (error as AppError).httpStatus ?? null };
    }
  }
  // Outbox read only — no acknowledgement is ever issued by this verification.
  try {
    const events = await client.listFinanceEvents('pending', 1, 1);
    results['events'] = { outcome: 'ok', shape: keys(events), items: events.items.length, total: events.total };
  } catch (error) {
    results['events'] = { outcome: 'error', code: safeCode(error), httpStatus: (error as AppError).httpStatus ?? null };
  }
  console.log(JSON.stringify({ status: 'finance_contract_verified', readOnly: true, mutatingCalls: 0, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'finance_contract_verification_failed', code: safeCode(error) }));
  process.exitCode = 1;
}
