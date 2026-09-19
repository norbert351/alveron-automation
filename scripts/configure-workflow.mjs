// Configures the Schedule Trigger interval of the development workflows from environment values
// and guarantees they remain INACTIVE. Never activates, deploys or touches a running instance.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function minutesFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 5 || value > 1440) {
    throw new Error(`${name} must be an integer between 5 and 1440`);
  }
  return value;
}

// n8n's Schedule Trigger supports minutes (1-59), hours (1-23) or days, so express legally.
function intervalFor(minutes) {
  if (minutes < 60) return { field: 'minutes', minutesInterval: minutes };
  if (minutes === 1440) return { field: 'days', daysInterval: 1 };
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours <= 23) return { field: 'hours', hoursInterval: hours };
  throw new Error('interval must be 5-59 minutes, a whole number of hours (1-23), or 1440');
}

function configure(file, envName, fallback) {
  const minutes = minutesFromEnv(envName, fallback);
  const interval = intervalFor(minutes);
  const path = resolve(file);
  const workflow = JSON.parse(readFileSync(path, 'utf8'));
  const node = workflow.nodes.find(candidate => candidate.type === 'n8n-nodes-base.scheduleTrigger');
  if (!node) throw new Error(`no Schedule Trigger found in ${file}`);
  node.parameters.rule.interval = [interval];
  workflow.active = false;
  writeFileSync(path, JSON.stringify(workflow, null, 2) + '\n');
  return { file, envName, minutes, interval };
}

const results = [
  configure('n8n/workflows/paid-order-confirmation.json', 'PAID_ORDER_POLL_MINUTES', 15),
  configure('n8n/workflows/referral-qualification.json', 'REFERRAL_QUALIFICATION_POLL_MINUTES', 60),
];
console.log(JSON.stringify({ status: 'configured', active: false, developmentOnly: true, results }));
