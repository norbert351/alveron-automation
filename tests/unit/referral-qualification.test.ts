import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, classifyFailure } from '../../src/integrations/alveron/errors.js';
import type { ReferralStats } from '../../src/integrations/alveron/schemas.js';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import type { AdminNotification, AdminNotifier } from '../../src/providers/admin/index.js';
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

function recorder() {
  const sent: AdminNotification[] = [];
  const notifier: AdminNotifier = {
    async notify(notification) { sent.push(notification); return { status: 'SUCCESS', simulated: true }; },
  };
  return { sent, notifier };
}

const field = (notification: AdminNotification, label: string): string | undefined =>
  notification.fields.find(entry => entry.label === label)?.value;

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

test('a zero-result hourly run sends no notification and records a baseline', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => stats), ledger, 60, () => clock, notifier);
    const baseline = await workflow.run();
    assert.equal(baseline.status, 'completed');
    assert.equal(baseline.adminNotificationStatus, undefined);
    assert.equal(sent.length, 0, 'a baseline run must not notify');
    clock += WINDOW_MS;
    const quiet = await workflow.run();
    assert.equal(quiet.status, 'completed');
    assert.equal(quiet.adminNotificationStatus, undefined);
    assert.equal(sent.length, 0, 'no new reward means no Telegram message');
    assert.equal(calls.count, 2, 'the scheduled job still runs hourly');
  } finally { ledger.close(); }
});

test('a newly recorded reward sends exactly one notification with safe aggregate context', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    let current = stats;
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => current), ledger, 60, () => clock, notifier);
    await workflow.run();
    assert.equal(sent.length, 0);
    clock += WINDOW_MS;
    current = { ...stats, rewarded: 2, totalRewards: 2000, qualified: 0 };
    const rewarded = await workflow.run();
    assert.equal(rewarded.status, 'completed');
    assert.equal(rewarded.adminNotificationStatus, 'SUCCESS');
    assert.equal(sent.length, 1);
    const notification = sent[0]!;
    assert.equal(notification.kind, 'REFERRAL_REWARD');
    assert.equal(notification.eventKey, 'referral-reward:2');
    assert.equal(notification.severity, 'INFO');
    assert.match(notification.heading, /REFERRAL REWARD ISSUED/);
    assert.match(field(notification, 'Reference') ?? '', /^reward-batch:/);
    assert.equal(field(notification, 'Reward amount'), 'not reported (Alveron aggregate stats)');
    assert.equal(field(notification, 'Newly rewarded'), '1');
    assert.equal(field(notification, 'Processing result'), 'Reward recorded by Alveron');
    assert.equal(field(notification, 'Observed at'), new Date(t10 + WINDOW_MS).toISOString());
  } finally { ledger.close(); }
});

test('the same reward state is never notified twice across later hourly runs or workflow restarts', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    let current = stats;
    const makeWorkflow = () => new ReferralQualificationWorkflow(
      stub(calls, async () => current), ledger, 60, () => clock, notifier);
    await makeWorkflow().run();
    clock += WINDOW_MS;
    current = { ...stats, rewarded: 2, totalRewards: 2000 };
    await makeWorkflow().run();
    assert.equal(sent.length, 1);
    clock += WINDOW_MS;
    const restarted = await makeWorkflow().run();
    assert.equal(restarted.status, 'completed');
    assert.equal(sent.length, 1, 'the persisted aggregate state suppresses a duplicate success');
    clock += WINDOW_MS;
    await makeWorkflow().run();
    assert.equal(sent.length, 1);
  } finally { ledger.close(); }
});

test('qualification without a reward increase is a warning, not a success', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    let current = { ...stats, qualified: 0 };
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => current), ledger, 60, () => clock, notifier);
    await workflow.run();
    clock += WINDOW_MS;
    current = { ...stats, qualified: 1, rewarded: stats.rewarded };
    const result = await workflow.run();
    assert.equal(result.status, 'completed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, 'REFERRAL_REWARD_ISSUE');
    assert.equal(sent[0]!.severity, 'WARNING');
    assert.match(sent[0]!.heading, /REWARD NOT RECORDED/);
    clock += WINDOW_MS;
    await workflow.run();
    assert.equal(sent.length, 1, 'the same unresolved state does not repeat every hour');
  } finally { ledger.close(); }
});

test('a processing failure sends no success notification, and exhausted retries raise a failure alert', async () => {
  const ledger = new SqliteLedger(':memory:', 1);
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => { throw new AppError('NETWORK_ERROR'); }), ledger, 60, () => t10, notifier);
    const failed = await workflow.run();
    assert.equal(failed.status, 'failed');
    assert.equal(sent.length, 0, 'the n8n error workflow owns definite processing failures');
    const exhausted = await workflow.run();
    assert.equal(exhausted.status, 'duplicate');
    assert.equal(exhausted.duplicate, 'ATTEMPTS_EXHAUSTED');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, 'AUTOMATION_ERROR');
    assert.match(sent[0]!.heading, /REFERRAL PROCESSING FAILED/);
    assert.equal(sent[0]!.severity, 'ERROR');
    assert.equal(field(sent[0]!, 'Result'), 'Retries exhausted; no success is claimed');
  } finally { ledger.close(); }
});

test('an existing rewarded referral is not rewarded or notified again', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    const workflow = new ReferralQualificationWorkflow(
      stub(calls, async () => stats), ledger, 60, () => clock, notifier);
    await workflow.run();
    for (let run = 0; run < 3; run++) {
      clock += WINDOW_MS;
      const result = await workflow.run();
      assert.equal(result.status, 'completed');
    }
    assert.equal(calls.count, 4, 'Alveron is still triggered each window');
    assert.equal(sent.length, 0, 'no duplicate reward notification');
  } finally { ledger.close(); }
});

test('the reward baseline survives a real ledger restart, not just a new workflow instance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'referral-restart-'));
  const path = join(directory, 'ledger.sqlite');
  try {
    const calls = { count: 0 };
    const { sent, notifier } = recorder();
    let clock = t10;
    let current = stats;
    const first = new SqliteLedger(path);
    try {
      await new ReferralQualificationWorkflow(
        stub(calls, async () => current), first, 60, () => clock, notifier).run();
      clock += WINDOW_MS;
      current = { ...stats, rewarded: 2, totalRewards: 2000 };
      await new ReferralQualificationWorkflow(
        stub(calls, async () => current), first, 60, () => clock, notifier).run();
      assert.equal(sent.length, 1);
    } finally { first.close(); }

    const reopened = new SqliteLedger(path);
    try {
      clock += WINDOW_MS;
      const afterRestart = await new ReferralQualificationWorkflow(
        stub(calls, async () => current), reopened, 60, () => clock, notifier).run();
      assert.equal(afterRestart.status, 'completed');
      assert.equal(sent.length, 1, 'the durable snapshot suppresses a duplicate after restart');
    } finally { reopened.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
