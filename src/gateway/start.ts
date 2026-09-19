import { makeApplication } from './application.js';
import { createGateway } from './server.js';
import { safeCode } from '../integrations/alveron/errors.js';
try {
  const { config, ledger, workflow, referral } = makeApplication();
  const server = createGateway(config.gatewayKey, { paidOrder: workflow, referral });
  server.on('error', () => { console.error(JSON.stringify({ code: 'GATEWAY_START_FAILED' })); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'gateway_started', port: config.port, developmentOnly: true })));
  const stop = () => server.close(() => { ledger.close(); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; }
