import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { safeCode } from '../integrations/alveron/errors.js';

export interface GatewayRoute { run(): Promise<{ status: string }>; }
export interface GatewayRoutes { paidOrder: GatewayRoute; referral: GatewayRoute; }

export function createGateway(key: string, routes: GatewayRoutes) {
  if (key.length < 32) throw new Error('GATEWAY_KEY_TOO_SHORT');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash(key);
  // Explicit route table. There is deliberately no generic proxy: no caller-supplied target URL,
  // no forwarded HTTP method, no wildcard route, no query strings.
  const table = new Map<string, GatewayRoute>([
    ['/internal/workflows/paid-order-confirmation/run', routes.paidOrder],
    ['/internal/workflows/referral-qualification/run', routes.referral],
  ]);
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    const supplied = req.headers['x-gateway-key'];
    if (typeof supplied !== 'string' || !timingSafeEqual(hash(supplied), expected)) { reply(401, { code: 'GATEWAY_AUTHENTICATION_FAILED' }); return; }
    if (req.url === '/internal/health' && req.method === 'GET') { reply(200, { status: 'alive', upstreamChecked: false }); return; }
    const route = typeof req.url === 'string' ? table.get(req.url) : undefined;
    if (!route) { reply(404, { code: 'NOT_FOUND' }); return; }
    if (req.method !== 'POST') { reply(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(415, { code: 'JSON_REQUIRED' }); return; }
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024) { reply(413, { code: 'BODY_TOO_LARGE' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { code: 'INVALID_BODY' }); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) { reply(400, { code: 'INVALID_BODY' }); return; }
      const result = await route.run();
      const status = result.status === 'failed' ? 502 : result.status === 'busy' ? 409 : 200;
      reply(status, result);
    } catch (error) { reply(502, { status: 'failed', code: safeCode(error) }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
