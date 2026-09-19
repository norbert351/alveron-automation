import { resolve } from 'node:path';
import { AppError } from './errors.js';

export interface Config {
  baseUrl: string;
  serviceEmail: string;
  servicePassword: string;
  gatewayKey: string;
  host: string;
  port: number;
  emailProvider: 'console' | 'unknown';
  adminEmail: string;
  ledgerPath: string;
  logLevel: string;
  timeoutMs: number;
  maxRetries: number;
  requestsPerMinute: number;
  referralWindowMinutes: number;
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value);
}

export function assertLoopbackBase(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !['/api', '/api/'].includes(url.pathname)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new AppError('CONFIG_INVALID'); }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const invalid = (): never => { throw new AppError('CONFIG_INVALID'); };
  const required = (key: string): string => {
    const value = env[key];
    if (!value || !value.trim()) return invalid();
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return invalid();
    return value;
  };
  if ((env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production' ||
      (env['FEATURE_ENABLE_ALVERON_WRITES'] ?? 'false') !== 'false') invalid();
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
  if (!['console', 'unknown'].includes(provider)) invalid();
  return {
    baseUrl: assertLoopbackBase(required('ALVERON_API_BASE_URL')),
    serviceEmail, servicePassword: required('ALVERON_SERVICE_PASSWORD'),
    gatewayKey, host,
    port: integer('GATEWAY_PORT', 8787, 1, 65535),
    emailProvider: provider as Config['emailProvider'], adminEmail,
    ledgerPath: resolve(ledgerPath), logLevel,
    timeoutMs: integer('HTTP_TIMEOUT_MS', 20000, 1, 120000),
    maxRetries: integer('HTTP_MAX_RETRIES', 2, 0, 3),
    requestsPerMinute: integer('HTTP_MAX_REQUESTS_PER_MINUTE', 40, 1, 40),
    referralWindowMinutes: integer('REFERRAL_QUALIFICATION_POLL_MINUTES', 60, 5, 1440),
  };
}
