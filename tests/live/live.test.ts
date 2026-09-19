/**
 * LIVE DEVELOPMENT TEST — opt-in only. Never touches production.
 *
 * Prerequisites (all supplied by the operator as environment variables, never committed):
 *   - a reachable DEVELOPMENT Alveron API (ALVERON_API_BASE_URL, loopback only)
 *   - a real development automation service account (ALVERON_SERVICE_EMAIL/PASSWORD)
 *   - EMAIL_PROVIDER=console (simulated delivery only)
 *   - LEDGER_DATABASE_URL pointing at a disposable development ledger file
 *
 * Behaviour per Phase 4 Step 30:
 *   - Without prerequisites the test reports SKIPPED (it never fabricates an environment).
 *   - It verifies connectivity, authentication and paid-order discovery using real dev data.
 *   - It does NOT send notifications unless LIVE_CONFIRM_NOTIFICATIONS=true is explicitly set,
 *     because Step 30 forbids manufacturing a paid order: without a genuinely paid dev order, STOP.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { makeClient } from '../../src/gateway/application.js';
import { isPaid } from '../../src/integrations/alveron/schemas.js';

const env = process.env;
const ready = Boolean(env.ALVERON_SERVICE_EMAIL && env.ALVERON_SERVICE_PASSWORD
  && env.ALVERON_API_BASE_URL && env.LEDGER_DATABASE_URL && env.ADMIN_ALERT_EMAIL
  && env.EMAIL_PROVIDER === 'console');

test('LIVE DEV: connectivity, authentication and paid-order discovery', async t => {
  if (!ready) { t.skip('LIVE dev prerequisites not configured (service account, loopback dev API, console provider). NOT RUN.'); return; }
  const config = loadConfig(env);
  const client = makeClient(config);
  const orders = await client.getOrders(); // failure must NOT be reported as an empty list
  const paid = orders.filter(order => isPaid(order.payment_status));
  console.log(JSON.stringify({ status: 'connected', returnedOrders: orders.length, paidCandidates: paid.length, noCompletenessGuarantee: true }));
  assert.ok(Array.isArray(orders));
  if (!paid.length) {
    t.skip('No genuinely paid development order found. Per Step 30: STOP — do not fabricate one.');
    return;
  }
  if (env.LIVE_CONFIRM_NOTIFICATIONS !== 'true') {
    console.log(JSON.stringify({ status: 'discovery_only', note: 'Set LIVE_CONFIRM_NOTIFICATIONS=true to run the notification flow via the safe console provider.' }));
    return;
  }
  const { makeApplication } = await import('../../src/gateway/application.js');
  const { ledger, workflow } = makeApplication(config);
  try {
    const first = await workflow.run();
    const second = await workflow.run();
    assert.equal(second.processed, 0, 'duplicate suppression failed on live data');
    console.log(JSON.stringify({ status: 'live_run_complete', runId: first.runId, processed: first.processed, skipped: second.skipped, failed: first.failed + second.failed }));
  } finally { ledger.close(); }
});
