import { resolve } from 'node:path';
import { AppError } from './errors.js';

export interface TelegramConfig {
  provider: 'disabled' | 'telegram';
  botToken: string | null;
  adminChatId: string | null;
  timeoutMs: number;
}

export type AutomationMode = 'live' | 'test' | 'disabled';

/**
 * Server-side Resend transactional-email configuration. Present only when `EMAIL_PROVIDER=resend`.
 * The API key is never logged, exported to n8n, embedded in workflow JSON, or returned in any
 * diagnostics — it lives solely in the operator's ignored secret file.
 */
export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  timeoutMs: number;
}

export interface Config {
  baseUrl: string;
  serviceEmail: string;
  servicePassword: string;
  gatewayKey: string;
  host: string;
  port: number;
  emailProvider: 'console' | 'unknown' | 'resend';
  resend: ResendConfig | null;
  adminEmail: string;
  ledgerPath: string;
  logLevel: string;
  timeoutMs: number;
  maxRetries: number;
  requestsPerMinute: number;
  referralWindowMinutes: number;
  /**
   * Paid orders not yet shipped after this many hours are reported as a shipping delay. This is
   * operational context only; it never changes an order's state in Alveron.
   */
  shippingSlaHours: number;
  telegram: TelegramConfig;
  /**
   * IANA timezone used to present finance periods and business days. Defaults to Africa/Lagos.
   * This affects display only; all financial values remain Alveron-authoritative.
   */
  financeTimezone: string;
  /**
   * Deterministic anomaly thresholds (monitoring only, never financial calculations). A value of 0
   * disables the corresponding anomaly signal.
   */
  financeAnomaly: {
    expenseSpike: number;
    refundRatePercent: number;
    revenueDropPercent: number;
    reconciliationIssues: number;
    payableSpike: number;
    missingCostItems: number;
  };
  /** An outstanding supplier payable at or above this whole-naira value is flagged as large. 0 disables. */
  financeLargePayableThreshold: number;
  /**
   * Bounded order-scan pagination. `GET /orders` is read with an explicit `limit`/`offset`
   * (Alveron clamps limit to 1..1000, offset to 0..100000) and never as an unbounded list.
   * `maxOrderPages` is the hard ceiling on pages per scan so a pagination bug can never loop
   * forever; a scan that reaches it is simply bounded, never infinite.
   */
  orderPageSize: number;
  maxOrderPages: number;
  environment: 'development' | 'test' | 'production';
  /**
   * Controls whether notification workflows are allowed to produce real customer-facing side
   * effects. In `test` mode, detection and admin (Telegram) alerts still run — so operators can
   * exercise the full pipeline — but customer email is intercepted at the provider boundary and
   * reported as simulated. In `disabled` mode customer email is never sent and fails closed.
   * Customer-email idempotency keys are scoped by mode, so a test/disabled run can never
   * suppress a later live send. Never mutates Alveron and never fabricates data.
   */
  automationMode: AutomationMode;
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value);
}

export function assertAllowedBaseUrl(value: string, allowRemote: boolean): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) ||
        url.username || url.password || url.search || url.hash ||
        !['/api', '/api/'].includes(url.pathname)) throw new Error();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // Loopback remains the default in every mode. A remote base URL is accepted ONLY when
    // explicitly opted in AND served over https (never plain-HTTP remote). See
    // docs/LIVE_ALVERON_CONNECTION_REQUIREMENTS.md §6.
    if (!loopback && !(allowRemote && url.protocol === 'https:')) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new AppError('CONFIG_INVALID'); }
}

/** Backwards-compatible name retained for callers that must assert loopback-only. */
export const assertLoopbackBase = (value: string): string =>
  assertAllowedBaseUrl(value, false);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const invalid = (): never => { throw new AppError('CONFIG_INVALID'); };
  const required = (key: string): string => {
    const value = env[key];
    if (!value || !value.trim()) return invalid();
    return value;
  };
  const optional = (key: string): string | null => {
    const value = env[key];
    return !value || !value.trim() ? null : value.trim();
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return invalid();
    return value;
  };
  // Writes are prohibited in every mode (development and production). The client has no write
  // methods at all; this is a fail-closed guarantee, never an override.
  if ((env['FEATURE_ENABLE_ALVERON_WRITES'] ?? 'false') !== 'false') invalid();
  // Explicit opt-in (https only) OR a loopback URL is required for ALVERON_API_BASE_URL.
  const allowRemote = (env['ALVERON_ALLOW_REMOTE_API'] ?? 'false') === 'true';
  const host = env['GATEWAY_HOST'] ?? '127.0.0.1';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) invalid();
  const serviceEmail = required('ALVERON_SERVICE_EMAIL');
  const adminEmail = required('ADMIN_ALERT_EMAIL');
  if (!validEmail(serviceEmail) || !validEmail(adminEmail)) invalid();
  const ledgerUrl = required('LEDGER_DATABASE_URL');
  if (!ledgerUrl.startsWith('sqlite:')) invalid();
  const ledgerPath = ledgerUrl.slice('sqlite:'.length);
  if (!/\.(?:sqlite|sqlite3|db)$/i.test(ledgerPath) || /[\r\n\0]/.test(ledgerPath)) invalid();
  const gatewayKey = required('GATEWAY_API_KEY');
  if (gatewayKey.length < 32) invalid();
  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) invalid();
  const provider = env['EMAIL_PROVIDER'] ?? 'unknown';
  if (!['console', 'unknown', 'resend'].includes(provider)) invalid();
  let resend: ResendConfig | null = null;
  if (provider === 'resend') {
    const apiKey = required('RESEND_API_KEY');
    if (!/^\S{8,200}$/.test(apiKey)) invalid();
    const fromEmail = required('RESEND_FROM_EMAIL');
    if (!validEmail(fromEmail)) invalid();
    const fromName = (env['RESEND_FROM_NAME'] ?? 'Alveron Fashion').trim();
    if (!fromName || fromName.length > 100 || /[<>\r\n\0]/.test(fromName)) invalid();
    resend = { apiKey, fromEmail, fromName, timeoutMs: integer('RESEND_TIMEOUT_MS', 10000, 1000, 30000) };
  }
  const telegramProvider = env['TELEGRAM_PROVIDER'] ?? 'disabled';
  if (!['disabled', 'telegram'].includes(telegramProvider)) invalid();
  const telegramBotToken = optional('TELEGRAM_BOT_TOKEN');
  const telegramAdminChatId = optional('TELEGRAM_ADMIN_CHAT_ID');
  if (telegramProvider === 'disabled' && (telegramBotToken !== null || telegramAdminChatId !== null)) invalid();
  if (telegramProvider === 'telegram' && (
    !telegramBotToken || !/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(telegramBotToken) ||
    !telegramAdminChatId || !/^(?:-?\d+|@[A-Za-z0-9_]{5,32})$/.test(telegramAdminChatId))) invalid();
  const financeTimezone = (env['FINANCE_TIMEZONE'] ?? 'Africa/Lagos').trim();
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(financeTimezone)) invalid();
  try { new Intl.DateTimeFormat('en-GB', { timeZone: financeTimezone }); }
  catch { invalid(); }
  const environment = (env['NODE_ENV'] ?? 'development').trim().toLowerCase();
  if (!['development', 'test', 'production'].includes(environment)) invalid();
  if (environment === 'production' && provider === 'console') invalid();
  const automationMode = (env['ALVERON_AUTOMATION_MODE'] ?? 'live').trim().toLowerCase();
  if (!['live', 'test', 'disabled'].includes(automationMode)) invalid();
  return {
    baseUrl: assertAllowedBaseUrl(required('ALVERON_API_BASE_URL'), allowRemote),
    serviceEmail, servicePassword: required('ALVERON_SERVICE_PASSWORD'),
    gatewayKey, host,
    port: integer('GATEWAY_PORT', 8787, 1, 65535),
    emailProvider: provider as Config['emailProvider'], resend, adminEmail,
    ledgerPath: resolve(ledgerPath), logLevel,
    timeoutMs: integer('HTTP_TIMEOUT_MS', 20000, 1, 120000),
    maxRetries: integer('HTTP_MAX_RETRIES', 2, 0, 3),
    requestsPerMinute: integer('HTTP_MAX_REQUESTS_PER_MINUTE', 40, 1, 40),
    referralWindowMinutes: integer('REFERRAL_QUALIFICATION_POLL_MINUTES', 60, 5, 1440),
    shippingSlaHours: integer('SHIPPING_SLA_HOURS', 48, 1, 8760),
    telegram: {
      provider: telegramProvider as TelegramConfig['provider'],
      botToken: telegramBotToken,
      adminChatId: telegramAdminChatId,
      timeoutMs: integer('TELEGRAM_TIMEOUT_MS', 10000, 1000, 30000),
    },
    financeTimezone,
    financeAnomaly: {
      expenseSpike: integer('FINANCE_EXPENSE_SPIKE_THRESHOLD', 0, 0, 1000000000000),
      refundRatePercent: integer('FINANCE_REFUND_RATE_THRESHOLD_PERCENT', 0, 0, 100),
      revenueDropPercent: integer('FINANCE_REVENUE_DROP_THRESHOLD_PERCENT', 0, 0, 100),
      reconciliationIssues: integer('FINANCE_RECONCILIATION_ISSUE_THRESHOLD', 0, 0, 100000),
      payableSpike: integer('FINANCE_PAYABLE_SPIKE_THRESHOLD', 0, 0, 1000000000000),
      missingCostItems: integer('FINANCE_MISSING_COST_THRESHOLD', 0, 0, 100000),
    },
    financeLargePayableThreshold: integer('FINANCE_LARGE_PAYABLE_THRESHOLD', 0, 0, 1000000000000),
    orderPageSize: integer('ALVERON_ORDER_PAGE_SIZE', 100, 1, 1000),
    maxOrderPages: integer('ALVERON_ORDER_MAX_PAGES', 20, 1, 100),
    environment: environment as Config['environment'],
    automationMode: automationMode as AutomationMode,
  };
}
