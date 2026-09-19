import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, classifyFailure } from '../../src/integrations/alveron/errors.js';
import type { ReferralStats } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { computeReferralWindow } from '../../src/services/referral-qualification-window.js';
import { ReferralQualificationWorkflow } from '../../src/workflows/referral-qualification.js';

// Synthetic aggregate fixture shaped exactly like Alveron's getAdminReferralStats() response.
const stats: ReferralStats = { total: 4, pending: 1, qualified: 1, rewarded: 1, cancelled: 1,
  totalDiscounts: 2000, totalRewards: 1000, totalCreditIssued: 1000, totalCreditRedeemed: 0, conversionRate: 50 };
const WINDOW_MS = 60 * 60 * 1000;
const t10 = Date.parse('2026-09-16T10:00:00Z');

function stub(calls: { count: number }, behaviour: () => Promise<ReferralStats>) {
  return { triggerReferralProcessing: async () => { calls.count++; return behaviour(); } };
}

test('window identity is deterministic per interval and changes on the next window', () => {
  const a = computeReferralWindow(t10, 60);
  const b = computeReferralWindow(t10 + 59 * 60 * 1000, 60);
  const c = computeReferralWindow(t10 + WINDOW_MS, 60);
  assert.equal(a.windowId, '2026-09-16T10:00Z');
  assert.equal(b.windowId, a.windowId, 'same interval bucket must be identical');
  assert.equal(c.windowId, '2026-09-16T11:00Z');
  assert.equal(a.executionKey, 'referral-qualification:2026-09-16T10:00Z');
  assert.throws(() => computeReferralWindow(t10, 4), { message: 'CONFIG_INVALID' });
  assert.throws(() => computeReferralWindow(t10, 1441), { message: 'CONFIG_INVALID' });
});

test('success is recorded, and a repeat inside the same window is suppressed without calling Alveron', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const workflow = new ReferralQualificationWorkflow(stub(calls, async () => stats), ledger, 60, () => t10);
    const first = await workflow.run();
    assert.equal(first.status, 'completed');
    assert.equal(first.httpSucceeded, true);
    assert.equal(first.sideEffectInvoked, true);
    assert.equal(first.processedCount, null, 'processed count is never invented');
    assert.deepEqual(first.observations, stats);
    const second = await workflow.run();
    assert.equal(second.status, 'duplicate');
    assert.equal(second.duplicate, 'ALREADY_COMPLETED');
    assert.equal(second.sideEffectInvoked, false);
    assert.equal(calls.count, 1, 'Alveron must not be called twice for one window');
  } finally { ledger.close(); }
});

test('Run A success does not suppress Run B in the next window', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    let clock = t10;
    const workflow = new ReferralQualificationWorkflow(stub(calls, async () => stats), ledger, 60, () => clock);
    assert.equal((await workflow.run()).status, 'completed');
    clock = t10 + WINDOW_MS;
    const runB = await workflow.run();
    assert.equal(runB.status, 'completed', 'the next legitimate scheduled execution must run');
    assert.equal(runB.windowId, '2026-09-16T11:00Z');
    assert.equal(calls.count, 2);
  } finally { ledger.close(); }
});

test('two simultaneous executions of the same window cause exactly one Alveron invocation', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => { await new Promise(resolve => setTimeout(resolve, 10)); return stats; }),
      ledger, 60, () => t10);
    const results = await Promise.all([workflow.run(), workflow.run()]);
    assert.equal(calls.count, 1);
    assert.deepEqual(results.map(r => r.status).sort(), ['completed', 'duplicate']);
    assert.equal(results.find(r => r.status === 'duplicate')?.duplicate, 'ALREADY_RUNNING');
  } finally { ledger.close(); }
});

test('an Alveron failure is never reported as success, and stays retryable within the window', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let fail = true;
    const calls = { count: 0 };
    const client = { triggerReferralProcessing: async () => {
      calls.count++;
      if (fail) throw new AppError('NETWORK_ERROR');
      return stats;
    } };
    const workflow = new ReferralQualificationWorkflow(client, ledger, 60, () => t10);
    const failed = await workflow.run();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.httpSucceeded, false);
    assert.equal(failed.sideEffectInvoked, false);
    assert.equal(failed.failureCategory, 'NETWORK_ERROR');
    assert.equal(failed.ledgerRecorded, true);
    assert.equal(ledger.get('referral-qualification:2026-09-16T10:00Z')?.status, 'FAILED');
    fail = false;
    const retried = await workflow.run();
    assert.equal(retried.status, 'completed', 'a definite failure may be retried inside the window');
    assert.equal(calls.count, 2);
  } finally { ledger.close(); }
});

test('retries are bounded: attempts exhausted yields a duplicate, not another call', async () => {
  const ledger = new SqliteLedger(':memory:', 1);
  try {
    const calls = { count: 0 };
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => { throw new AppError('ALVERON_API_FAILURE'); }), ledger, 60, () => t10);
    assert.equal((await workflow.run()).status, 'failed');
    const exhausted = await workflow.run();
    assert.equal(exhausted.status, 'duplicate');
    assert.equal(exhausted.duplicate, 'ATTEMPTS_EXHAUSTED');
    assert.equal(calls.count, 1);
  } finally { ledger.close(); }
});

test('failure categories distinguish transient from permanent without leaking messages', () => {
  assert.equal(classifyFailure(new AppError('CONFIG_INVALID')), 'CONFIGURATION_ERROR');
  assert.equal(classifyFailure(new AppError('AUTHENTICATION_FAILED')), 'AUTHENTICATION_ERROR');
  assert.equal(classifyFailure(new AppError('ALVERON_API_FAILURE', 403)), 'AUTHORIZATION_ERROR');
  assert.equal(classifyFailure(new AppError('RATE_LIMITED', 429)), 'RATE_LIMITED');
  assert.equal(classifyFailure(new AppError('ALVERON_API_FAILURE', 503)), 'ALVERON_SERVER_ERROR');
  assert.equal(classifyFailure(new AppError('NETWORK_ERROR')), 'NETWORK_ERROR');
  assert.equal(classifyFailure(new AppError('INVALID_RESPONSE')), 'INVALID_RESPONSE');
  assert.equal(classifyFailure(new AppError('LEDGER_FAILURE')), 'LEDGER_ERROR');
  assert.equal(classifyFailure(new Error('raw internal text')), 'UNKNOWN_ERROR');
});
