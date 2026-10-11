import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type Config } from '../integrations/alveron/config.js';
import { createLogger } from '../integrations/alveron/logger.js';
import { HttpTransport } from '../integrations/alveron/http.js';
import { AuthManager } from '../integrations/alveron/auth.js';
import { AlveronClient } from '../integrations/alveron/client.js';
import { SqliteLedger } from '../ledger/sqlite-ledger.js';
import {
  ConsoleEmailProvider, ModeAwareEmailProvider, NotificationNotSent, ResendEmailProvider, type EmailProvider,
} from '../providers/email/index.js';
import { DisabledAdminNotificationProvider, type AdminNotificationProvider } from '../providers/admin/index.js';
import { AdminNotificationService } from '../providers/admin/service.js';
import { TelegramAdminNotificationProvider } from '../providers/telegram.js';
import { AutomationErrorNotificationRoute } from './admin-notification-route.js';
import { PaidOrderWorkflow } from '../workflows/paid-order-confirmation.js';
import { ReferralQualificationWorkflow } from '../workflows/referral-qualification.js';
import { ProductRequestNotificationWorkflow } from '../workflows/product-request-notification.js';
import { LowStockNotificationWorkflow } from '../workflows/low-stock-notification.js';
import { OrderOperationsWorkflow } from '../workflows/order-operations.js';
import { PaymentReconciliationWorkflow } from '../workflows/payment-reconciliation.js';
import { ShippingSlaWorkflow } from '../workflows/shipping-sla.js';
import { SystemHealthWorkflow } from '../workflows/system-health.js';
import { FinanceDailyReportWorkflow } from '../workflows/finance-daily-report.js';
import { FinanceWeeklyReportWorkflow } from '../workflows/finance-weekly-report.js';
import { FinanceReconciliationWorkflow } from '../workflows/finance-reconciliation.js';
import { FinanceExpenseReviewWorkflow } from '../workflows/finance-expense-review.js';
import { FinanceSupplierPayablesWorkflow } from '../workflows/finance-supplier-payables.js';
import { FinanceReviewDigestWorkflow } from '../workflows/finance-review-digest.js';
import { FinanceAnomalyMonitorWorkflow } from '../workflows/finance-anomaly-monitor.js';
import { FinanceEventsConsumerWorkflow } from '../workflows/finance-events-consumer.js';
import { AutomationEventsConsumerWorkflow } from '../workflows/automation-events-consumer.js';
import { DailyOperationsSummaryWorkflow } from '../workflows/daily-operations-summary.js';

export function makeClient(config: Config) {
  const logger = createLogger(config.logLevel);
  const http = new HttpTransport(config, logger);
  return new AlveronClient(http, new AuthManager(http, logger), config.orderPageSize, config.maxOrderPages);
}
export function makeApplication(config = loadConfig()) {
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const ledger = new SqliteLedger(config.ledgerPath);
  const unavailable = async (): Promise<never> => { throw new NotificationNotSent('CONFIGURATION_ERROR'); };
  const unavailableProvider: EmailProvider = {
    namespace: 'unknown', sendCustomerOrderConfirmation: unavailable,
    sendAdminOrderAlert: unavailable, sendCustomerTransactional: unavailable,
  };
  const baseProvider: EmailProvider = config.emailProvider === 'console' ? new ConsoleEmailProvider()
    : config.emailProvider === 'resend' && config.resend ? new ResendEmailProvider(config.resend)
      : unavailableProvider;
  const provider = new ModeAwareEmailProvider(baseProvider, config.automationMode);
  const adminProvider: AdminNotificationProvider = config.telegram.provider === 'telegram'
    ? new TelegramAdminNotificationProvider(
      config.telegram.botToken!, config.telegram.adminChatId!, config.telegram.timeoutMs,
    )
    : new DisabledAdminNotificationProvider();
  const adminNotifications = new AdminNotificationService(ledger, adminProvider, createLogger(config.logLevel));
  const client = makeClient(config);
  return { config, ledger,
    workflow: new PaidOrderWorkflow(client, ledger, provider, config.adminEmail, adminNotifications),
    referral: new ReferralQualificationWorkflow(client, ledger, config.referralWindowMinutes, Date.now, adminNotifications),
    productRequests: new ProductRequestNotificationWorkflow(client, adminNotifications),
    lowStock: new LowStockNotificationWorkflow(client, adminNotifications, { ledger }),
    orderOperations: new OrderOperationsWorkflow(client, adminNotifications, { emailProvider: provider, ledger }),
    reconciliation: new PaymentReconciliationWorkflow(client, adminNotifications),
    shippingSla: new ShippingSlaWorkflow(client, config.shippingSlaHours, adminNotifications),
    systemHealth: new SystemHealthWorkflow(client, adminProvider.enabled, adminNotifications, config.environment),
    financeDailyReport: new FinanceDailyReportWorkflow(client, adminNotifications, config.financeTimezone),
    financeWeeklyReport: new FinanceWeeklyReportWorkflow(client, adminNotifications, config.financeTimezone),
    financeReconciliation: new FinanceReconciliationWorkflow(client, adminNotifications),
    financeExpenseReview: new FinanceExpenseReviewWorkflow(client, adminNotifications, config.financeTimezone),
    financeSupplierPayables: new FinanceSupplierPayablesWorkflow(client,
      { largePayableThreshold: config.financeLargePayableThreshold }, adminNotifications, config.financeTimezone),
    financeReviewDigest: new FinanceReviewDigestWorkflow(client, adminNotifications, config.financeTimezone),
    financeAnomalyMonitor: new FinanceAnomalyMonitorWorkflow(client, config.financeAnomaly, adminNotifications, config.financeTimezone),
    financeEventsConsumer: new FinanceEventsConsumerWorkflow(client, adminNotifications),
    automationEvents: new AutomationEventsConsumerWorkflow(client, adminNotifications),
    dailyOperations: new DailyOperationsSummaryWorkflow(client, adminNotifications, config.financeTimezone),
    automationErrors: new AutomationErrorNotificationRoute(adminNotifications) };
}
