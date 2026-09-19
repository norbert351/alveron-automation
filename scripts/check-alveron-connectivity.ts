import { loadConfig } from '../src/integrations/alveron/config.js';
import { makeClient } from '../src/gateway/application.js';
import { safeCode } from '../src/integrations/alveron/errors.js';
try {
  const client = makeClient(loadConfig());
  const orders = await client.getOrders();
  console.log(JSON.stringify({ status: 'connected', returnedOrders: orders.length, completeness: 'unknown', readOnly: true }));
} catch (error) { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; }
