import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/integrations/alveron/config.js';
import { AppError, safeCode } from '../src/integrations/alveron/errors.js';
import { telegramTestNotification } from '../src/providers/admin/index.js';
import { TelegramAdminNotificationProvider } from '../src/providers/telegram.js';

const healthy = async (url: string, init?: RequestInit): Promise<boolean> => {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
};

try {
  const config = loadConfig();
  if (config.telegram.provider !== 'telegram' || !config.telegram.botToken || !config.telegram.adminChatId) {
    throw new AppError('CONFIG_INVALID');
  }
  const gatewayHealthy = await healthy(`http://${config.host}:${config.port}/internal/health`, {
    headers: { 'x-gateway-key': config.gatewayKey },
  });
  if (!gatewayHealthy) throw new AppError('GATEWAY_UNAVAILABLE');
  if (!await healthy('http://127.0.0.1:5678/healthz')) throw new AppError('N8N_UNAVAILABLE');
  const provider = new TelegramAdminNotificationProvider(
    config.telegram.botToken, config.telegram.adminChatId, config.telegram.timeoutMs,
  );
  const eventId = randomUUID();
  await provider.send(telegramTestNotification(config.environment, eventId), `telegram-test:${eventId}`);
  console.log(JSON.stringify({ status: 'telegram_test_sent', scope: 'provider', environment: config.environment, gateway: 'connected', n8n: 'connected' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'telegram_test_failed', code: safeCode(error) }));
  process.exitCode = 1;
}
