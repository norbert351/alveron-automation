// Configures the Schedule Trigger interval of the development workflows from environment values
// and guarantees they remain INACTIVE. Never activates, deploys or touches a running instance.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function minutesFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  // 10080 (one week) is a documented schedule (finance-weekly-report). intervalFor() expresses it
  // as a `weeks` interval, so the validator must allow it rather than capping at 1440.
  if (!Number.isInteger(value) || value < 5 || (value > 1440 && value !== 10080)) {
    throw new Error(`${name} must be an integer between 5 and 1440, or 10080 (weekly)`);
  }
  return value;
}

// n8n's Schedule Trigger supports minutes (1-59), hours (1-23), days or weeks, so express legally.
// 10080 minutes = one week, which n8n expresses as a `weeks` interval rather than 7 days.
function intervalFor(minutes) {
  if (minutes < 60) return { field: 'minutes', minutesInterval: minutes };
  if (minutes === 1440) return { field: 'days', daysInterval: 1 };
  if (minutes === 10080) return { field: 'weeks', weeksInterval: 1 };
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours <= 23) return { field: 'hours', hoursInterval: hours };
  throw new Error('interval must be 5-59 minutes, a whole number of hours (1-23), 1440 (daily) or 10080 (weekly)');
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
  configure('n8n/workflows/product-request-notification.json', 'PRODUCT_REQUEST_POLL_MINUTES', 15),
  configure('n8n/workflows/low-stock-notification.json', 'LOW_STOCK_POLL_MINUTES', 360),
  configure('n8n/workflows/order-operations.json', 'ORDER_OPERATIONS_POLL_MINUTES', 60),
  configure('n8n/workflows/payment-reconciliation.json', 'PAYMENT_RECONCILIATION_POLL_MINUTES', 15),
  configure('n8n/workflows/shipping-sla.json', 'SHIPPING_SLA_POLL_MINUTES', 60),
  configure('n8n/workflows/system-health.json', 'SYSTEM_HEALTH_POLL_MINUTES', 15),
  configure('n8n/workflows/finance-daily-report.json', 'FINANCE_DAILY_REPORT_POLL_MINUTES', 1440),
  configure('n8n/workflows/finance-weekly-report.json', 'FINANCE_WEEKLY_REPORT_POLL_MINUTES', 10080),
  configure('n8n/workflows/finance-reconciliation.json', 'FINANCE_RECONCILIATION_POLL_MINUTES', 15),
  configure('n8n/workflows/finance-expense-review.json', 'FINANCE_EXPENSE_REVIEW_POLL_MINUTES', 30),
  configure('n8n/workflows/finance-supplier-payables.json', 'FINANCE_SUPPLIER_PAYABLES_POLL_MINUTES', 1440),
  configure('n8n/workflows/finance-review-digest.json', 'FINANCE_REVIEW_DIGEST_POLL_MINUTES', 1440),
  configure('n8n/workflows/finance-anomaly-monitor.json', 'FINANCE_ANOMALY_MONITOR_POLL_MINUTES', 1440),
  configure('n8n/workflows/finance-events-consumer.json', 'FINANCE_EVENTS_CONSUMER_POLL_MINUTES', 15),
  configure('n8n/workflows/automation-events.json', 'AUTOMATION_EVENTS_POLL_MINUTES', 15),
  configure('n8n/workflows/daily-operations-summary.json', 'DAILY_OPERATIONS_POLL_MINUTES', 1440),
];
console.log(JSON.stringify({ status: 'configured', active: false, developmentOnly: true, results }));
