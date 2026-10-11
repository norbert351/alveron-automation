import { makeApplication } from './application.js';
import { createGateway } from './server.js';
import { safeCode } from '../integrations/alveron/errors.js';
try {
  const { config, ledger, workflow, referral, productRequests, lowStock,
    orderOperations, reconciliation, shippingSla, systemHealth, financeDailyReport,
    financeWeeklyReport, financeReconciliation, financeExpenseReview, financeSupplierPayables,
    financeReviewDigest, financeAnomalyMonitor, financeEventsConsumer, automationEvents,
    dailyOperations, automationErrors } = makeApplication();
  const server = createGateway(config.gatewayKey, {
    paidOrder: workflow, referral, adminNotification: automationErrors,
    productRequests, lowStock, orderOperations, reconciliation, shippingSla, systemHealth,
    financeDailyReport, financeWeeklyReport, financeReconciliation, financeExpenseReview,
    financeSupplierPayables, financeReviewDigest, financeAnomalyMonitor, financeEventsConsumer,
    automationEvents, dailyOperations,
  });
  server.on('error', () => { console.error(JSON.stringify({ code: 'GATEWAY_START_FAILED' })); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'gateway_started', port: config.port, environment: (process.env['NODE_ENV'] ?? 'development'), bindOnly: '127.0.0.1' })));
  const stop = () => server.close(() => { ledger.close(); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; }
