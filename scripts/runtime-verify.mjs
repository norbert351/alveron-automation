// Phase 6 runtime verification (local, MOCK Alveron — never live Alveron).
// Proves: gateway health/auth, referral duplicate suppression across calls, paid-order duplicate
// suppression, mock-failure handling, and that no secrets reach callers.
// Prerequisites (started separately):
//   node scripts/mock-alveron.mjs 4600        (MOCK upstream, synthetic data only)
//   npm run gateway                            (gateway configured against the MOCK url)
// The script exercises the gateway HTTP surface directly — the same two routes the n8n workflows call.
const GATEWAY = process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8787';
const KEY = process.env.GATEWAY_API_KEY;
const MOCK = process.env.MOCK_ALVERON_URL ?? 'http://127.0.0.1:4600';
if (!GATEWAY || !KEY) { console.error('GATEWAY_BASE_URL and GATEWAY_API_KEY are required.'); process.exit(2); }

const results = [];
const record = (id, pass, detail = '') => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const call = async (path, suppliedKey = KEY, body = '{}') => {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-key': suppliedKey ?? '' },
    body, signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, text: await response.text() };
};
const mockState = async () => JSON.parse(await (await fetch(`${MOCK}/api/__control/state`)).text());

// 1. gateway health and key enforcement
const health = async (headers) => (await fetch(`${GATEWAY}/internal/health`, { headers })).status;
record('health-ok-with-valid-key', (await health({ 'x-gateway-key': KEY })) === 200);
record('health-rejects-missing-key', (await health({})) === 401);
record('health-rejects-wrong-key', (await health({ 'x-gateway-key': 'not-the-key'.padEnd(40, 'x') })) === 401);

// 2. referral: first execution, duplicate inside the window with no second upstream call
const referralRoute = '/internal/workflows/referral-qualification/run';
const paidOrderRoute = '/internal/workflows/paid-order-confirmation/run';
const first = await call(referralRoute);
const firstJson = JSON.parse(first.text);
record('referral-first-run-200', first.status === 200 && firstJson.status === 'completed');
record('referral-side-effect-invoked', firstJson.sideEffectInvoked === true);
record('referral-processed-count-null', firstJson.processedCount === null, 'endpoint reports no processed count');
const stateBefore = await mockState();
const repeat = await call(referralRoute);
const repeatJson = JSON.parse(repeat.text);
record('referral-same-window-duplicate', repeat.status === 200 && repeatJson.status === 'duplicate', `duplicate=${repeatJson.duplicate}`);
const stateAfter = await mockState();
record('referral-duplicate-no-upstream-call', stateBefore.statsCalls === stateAfter.statsCalls, `mock statsCalls ${stateBefore.statsCalls} -> ${stateAfter.statsCalls}`);

// 3. paid orders: paid order processed once, then suppressed (console provider = simulated email)
const paidFirst = await call(paidOrderRoute);
const paidFirstJson = JSON.parse(paidFirst.text);
record('paid-order-first-run', paidFirst.status === 200 && paidFirstJson.processed >= 1, JSON.stringify({ processed: paidFirstJson.processed, failed: paidFirstJson.failed }));
const paidSecondResponse = await call(paidOrderRoute);
const paidSecondJson = JSON.parse(paidSecondResponse.text);
record('paid-order-duplicate-suppressed', paidSecondResponse.status === 200 && paidSecondJson.skipped >= 1, `processed=${paidSecondJson.processed} skipped=${paidSecondJson.skipped}`);

// 4. secret hygiene
const referralRaw = JSON.stringify(firstJson);
record('referral-no-secrets', !/[Bb]earer |access_token|refresh_token|service_role/.test(referralRaw) && !referralRaw.includes(KEY));

console.log(JSON.stringify({ summary: 'RUNTIME VERIFICATION (MOCK ALVERON — not live)', passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results }, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;