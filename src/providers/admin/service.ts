import type { Claim, Ledger } from '../../ledger/sqlite-ledger.js';
import type { Logger } from '../../integrations/alveron/logger.js';
import { NotificationNotSent } from '../notification-delivery.js';
import type {
  AdminNotification,
  AdminNotificationProvider,
  AdminNotificationResult,
  AdminNotifier,
} from './index.js';

export class AdminNotificationService implements AdminNotifier {
  constructor(
    private readonly ledger: Ledger,
    private readonly provider: AdminNotificationProvider,
    private readonly logger: Logger,
  ) {}

  async notify(notification: AdminNotification): Promise<AdminNotificationResult> {
    if (!this.provider.enabled) return { status: 'DISABLED' };
    const key = `${this.provider.namespace}:${notification.eventKey}`;
    let claim: Claim | null | undefined;
    try {
      claim = this.ledger.claim(key, notification.resourceId, `admin-notification:${notification.kind}`);
    } catch {
      this.logger.log('admin_notification_pending', { notificationType: notification.kind, code: 'LEDGER_FAILURE' });
      return { status: 'PENDING', reason: 'LEDGER_FAILURE' };
    }
    if (!claim) {
      this.logger.log('admin_notification_skipped', { notificationType: notification.kind });
      return { status: 'SKIPPED' };
    }
    try {
      const receipt = await this.provider.send(notification, key);
      try {
        this.ledger.markSuccess(claim, receipt.messageId);
      } catch {
        this.logger.log('admin_notification_pending', { notificationType: notification.kind, code: 'LEDGER_FAILURE' });
        return { status: 'PENDING', reason: 'LEDGER_FAILURE' };
      }
      this.logger.log('admin_notification_delivered', { notificationType: notification.kind });
      return { status: 'SUCCESS', simulated: receipt.simulated };
    } catch (error) {
      if (error instanceof NotificationNotSent) {
        try { this.ledger.markFailure(claim); }
        catch {
          this.logger.log('admin_notification_pending', { notificationType: notification.kind, code: 'LEDGER_FAILURE' });
          return { status: 'PENDING', reason: 'LEDGER_FAILURE' };
        }
        this.logger.log('admin_notification_failed', {
          notificationType: notification.kind, code: 'NOTIFICATION_NOT_SENT',
        });
        return { status: 'FAILED', reason: 'NOTIFICATION_NOT_SENT' };
      }
      this.logger.log('admin_notification_pending', { notificationType: notification.kind });
      return { status: 'PENDING', reason: 'DELIVERY_RECONCILIATION_REQUIRED' };
    }
  }
}
