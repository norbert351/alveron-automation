// LOCAL MOCK ALVERON — SYNTHETIC DATA ONLY. NEVER CONNECT THIS TO PRODUCTION.
//
// Purpose: allow the real n8n → gateway → "Alveron" chain to be verified end-to-end before the
// operator supplies a real development ALVERON_API_BASE_URL and service account (both UNKNOWN).
// It implements exactly the three read paths the automation client is allowed to call, plus a
// control endpoint used to simulate upstream failures. It never touches production data and
// never sends Paystack or Supabase traffic.
//
// Usage: node scripts/mock-alveron.mjs [port]
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_ALVERON_PORT ?? 4600);
const MOCK_EMAIL = process.env.MOCK_ALVERON_EMAIL ?? 'mock-service@example.invalid';
const MOCK_PASSWORD = process.env.MOCK_ALVERON_PASSWORD ?? 'mock-password-not-a-secret';
let statsCalls = 0; let orderCalls = 0; let failMode = false;

const paidId = randomUUID(); const paidNoEmailId = randomUUID(); const unpaidId = randomUUID();
const paidOrder = { id: paidId, order_number: 7, status: 'paid', payment_status: 'SUCCESS',
  customer_name: 'Mock Customer', customer_email: 'mock-customer@example.invalid',
  subtotal: 30000, discount: 0, shipping: 2000, total: 32000, currency: 'NGN',
  items: [{ title: 'Mock garment', variant_title: 'M', quantity: 1, price: 30000 }],
  payments: [{ id: randomUUID(), order_id: paidId, provider_reference: 'mock-reference', amount: 3200000, currency: 'NGN', status: 'SUCCESS' }] };
const paidNoEmail = { ...paidOrder, id: paidNoEmailId, customer_email: null };
const unpaid = { ...paidOrder, id: unpaidId, payment_status: 'PENDING', status: 'pending' };

console.log('MOCK ALVERON — synthetic data only. This is NOT a live Alveron API.');

const server = createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST' && req.url === '/api/__control/fail') {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    failMode = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').fail === true;
    return res.end(JSON.stringify({ mocked: true, failing: failMode }));
  }
  if (req.method === 'GET' && req.url === '/api/__control/state') {
    return res.end(JSON.stringify({ mock: true, statsCalls, ordersCalls: orderCalls, failMode }));
  }
  if (req.method === 'POST' && req.url === '/api/auth/admin-login') {
    const chunks = []; for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (body.email !== MOCK_EMAIL || body.password !== MOCK_PASSWORD) { res.statusCode = 401; return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ user: { id: paidOrder.id }, session: { access_token: `mock-${randomUUID()}`, expires_in: 3600 },
      employee: { status: 'active', role: { slug: 'admin' } }, profile: { role: 'admin', status: 'active' } }));
  }
  if (req.headers.authorization && !String(req.headers.authorization).startsWith('Bearer mock-')) {
    res.statusCode = 401; return res.end('{}');
  }
  if (req.method !== 'GET') { res.statusCode = 404; return res.end('{}'); }
  if (req.url === '/api/referrals/admin/stats') {
    if (failMode) { res.statusCode = 503; return res.end('{}'); }
    statsCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ total: 10 + statsCalls, pending: 2, qualified: 3, rewarded: 4, cancelled: 1,
      totalDiscounts: 4000, totalRewards: 2000, totalCreditIssued: 2000, totalCreditRedeemed: 500, conversionRate: 50 }));
  }
  if (req.url === '/api/orders') {
    orderCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify([paidOrder, paidNoEmail, unpaid]));
  }
  const match = req.url.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
  if (match) {
    const found = [paidOrder, paidNoEmail, unpaid].find(o => o.id === match[1]);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(found ? { ...found, events: [] } : {}));
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(PORT, '127.0.0.1', () => console.log(`MOCK ALVERON listening on 127.0.0.1:${PORT} (synthetic data only)`));
