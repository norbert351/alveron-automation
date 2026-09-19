export interface Logger {
  log(event: string, fields?: Record<string, unknown>): void;
}

const events = new Set([
  'http_attempt', 'http_retry', 'http_failure', 'auth_success', 'auth_failure',
  'gateway_started', 'gateway_request', 'gateway_error', 'confirmation_sent',
  'confirmation_skipped', 'confirmation_failed', 'email_console', 'admin_alert',
]);
const codes = new Set([
  'AUTHENTICATION_FAILED', 'ALVERON_API_FAILURE', 'RATE_LIMITED', 'VALIDATION_FAILED',
  'CUSTOMER_EMAIL_MISSING', 'CONFIG_INVALID', 'INTERNAL_ERROR',
]);
const numeric = new Set(['status', 'httpStatus', 'attempt', 'durationMs', 'count', 'port']);

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
      }
      try { sink(JSON.stringify(entry)); } catch { /* Logging must not expose or mask application errors. */ }
    },
  };
}
