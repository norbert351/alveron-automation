export interface Logger {
  log(event: string, fields?: Record<string, unknown>): void;
}

const events = new Set([
  'http_attempt', 'http_retry', 'http_failure', 'auth_success', 'auth_failure',
  'gateway_started', 'gateway_request', 'gateway_error', 'confirmation_sent',
  'confirmation_skipped', 'confirmation_failed', 'email_console', 'admin_alert',
  'admin_notification_delivered', 'admin_notification_skipped', 'admin_notification_failed',
  'admin_notification_pending',
]);
const codes = new Set([
  'AUTHENTICATION_FAILED', 'ALVERON_API_FAILURE', 'RATE_LIMITED', 'VALIDATION_FAILED',
  'CUSTOMER_EMAIL_MISSING', 'CONFIG_INVALID', 'INTERNAL_ERROR', 'NOTIFICATION_NOT_SENT',
  'LEDGER_FAILURE',
]);
const numeric = new Set(['status', 'httpStatus', 'attempt', 'durationMs', 'count', 'port']);
const notificationTypes = new Set([
  'PAID_ORDER', 'PAYMENT_FAILURE', 'REFERRAL_PROCESSING', 'AUTOMATION_ERROR', 'TELEGRAM_TEST',
  'PRODUCT_REQUEST', 'LOW_STOCK', 'OUT_OF_STOCK', 'ORDER_STATUS', 'SHIPPING_SLA',
  'PAYMENT_RECONCILIATION', 'SYSTEM_HEALTH', 'FINANCE_DAILY_REPORT', 'FINANCE_WEEKLY_REPORT',
  'FINANCE_RECONCILIATION', 'FINANCE_EXPENSE_REVIEW', 'FINANCE_PAYABLE', 'FINANCE_REVIEW_DIGEST',
  'FINANCE_ANOMALY', 'FINANCE_UNAVAILABLE', 'OWNER_WITHDRAWAL', 'FINANCE_REFUND', 'FINANCE_CAPITAL',
  'PRODUCT_REQUEST_STATUS', 'ORDER_ISSUE', 'RESTOCK', 'DAILY_OPERATIONS',
]);

export function createLogger(
  level = 'info',
  sink: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); },
): Logger {
  return {
    log(event, fields = {}) {
      if (level === 'silent') return;
      const entry: Record<string, unknown> = {
        event: events.has(event) ? event : 'event',
      };
      for (const [key, value] of Object.entries(fields)) {
        if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value)) entry[key] = value;
        if (key === 'code' && typeof value === 'string' && codes.has(value)) entry[key] = value;
        if (key === 'method' && (value === 'GET' || value === 'POST')) entry[key] = value;
        if (key === 'operation' && ['login', 'list_orders', 'get_order'].includes(String(value))) entry[key] = value;
        if (key === 'notificationType' && notificationTypes.has(String(value))) entry[key] = value;
      }
      try { sink(JSON.stringify(entry)); } catch { /* Logging must not expose or mask application errors. */ }
    },
  };
}
