import { loadConfig } from '../src/integrations/alveron/config.js';
import { safeCode } from '../src/integrations/alveron/errors.js';
try { loadConfig(); console.log(JSON.stringify({ status: 'configuration_valid', developmentOnly: true })); }
catch (error) { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; }
