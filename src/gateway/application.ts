import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type Config } from '../integrations/alveron/config.js';
import { createLogger } from '../integrations/alveron/logger.js';
import { HttpTransport } from '../integrations/alveron/http.js';
import { AuthManager } from '../integrations/alveron/auth.js';
import { AlveronClient } from '../integrations/alveron/client.js';
import { SqliteLedger } from '../ledger/sqlite-ledger.js';
import { ConsoleEmailProvider, NotificationNotSent, type EmailProvider } from '../providers/email/index.js';
import { PaidOrderWorkflow } from '../workflows/paid-order-confirmation.js';
import { ReferralQualificationWorkflow } from '../workflows/referral-qualification.js';

export function makeClient(config: Config) {
  const logger = createLogger(config.logLevel);
  const http = new HttpTransport(config, logger);
  return new AlveronClient(http, new AuthManager(http, logger));
}
export function makeApplication(config = loadConfig()) {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const ledger = new SqliteLedger(config.ledgerPath);
  const unavailable = async (): Promise<never> => { throw new NotificationNotSent(); };
  const provider: EmailProvider = config.emailProvider === 'console' ? new ConsoleEmailProvider() : {
    namespace: 'unknown', sendCustomerOrderConfirmation: unavailable, sendAdminOrderAlert: unavailable,
  };
  // One Alveron client (and therefore one authentication cache) shared by every workflow.
  const client = makeClient(config);
  return { config, ledger,
    workflow: new PaidOrderWorkflow(client, ledger, provider, config.adminEmail),
    referral: new ReferralQualificationWorkflow(client, ledger, config.referralWindowMinutes) };
}
