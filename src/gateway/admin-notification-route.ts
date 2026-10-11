import { AppError } from '../integrations/alveron/errors.js';
import {
  automationErrorNotification,
  type AdminNotifier,
  type AdminNotificationResult,
} from '../providers/admin/index.js';

const fields = ['workflow', 'executionId', 'category', 'errorCode', 'transient'];

function parseInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_FAILED');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== [...fields].sort().join(',')) throw new AppError('VALIDATION_FAILED');
  if (typeof input['workflow'] !== 'string' || !input['workflow'].trim() || input['workflow'].length > 200 ||
      typeof input['executionId'] !== 'string' || !input['executionId'].trim() || input['executionId'].length > 200 ||
      typeof input['category'] !== 'string' || typeof input['errorCode'] !== 'string' ||
      typeof input['transient'] !== 'boolean' || /[\0\r\n]/.test(input['workflow']) ||
      /[\0\r\n]/.test(input['executionId'])) throw new AppError('VALIDATION_FAILED');
  return {
    workflow: input['workflow'], executionId: input['executionId'], category: input['category'],
    errorCode: input['errorCode'], transient: input['transient'],
  };
}

export class AutomationErrorNotificationRoute {
  readonly bodyMode = 'automation-error';
  constructor(private readonly notifications: AdminNotifier) {}

  async run(input: unknown): Promise<{ status: 'accepted'; adminNotificationStatus: AdminNotificationResult['status'] }> {
    const notification = automationErrorNotification(parseInput(input));
    let status: AdminNotificationResult['status'] = 'FAILED';
    try { status = (await this.notifications.notify(notification)).status; }
    catch { status = 'FAILED'; }
    return { status: 'accepted', adminNotificationStatus: status };
  }
}
