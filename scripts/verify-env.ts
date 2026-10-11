import { loadConfig } from '../src/integrations/alveron/config.js';
import { safeCode } from '../src/integrations/alveron/errors.js';
try {
  const config = loadConfig();
  console.log(JSON.stringify({ status: 'configuration_valid', mode: config.environment,
    gatewayBind: config.host, emailProvider: config.emailProvider,
    automationMode: config.automationMode,
    telegramConfigured: config.telegram.provider === 'telegram' }));
} catch (error) { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; }
