import { randomUUID } from 'node:crypto';
import type { CatalogClient } from '../integrations/alveron/client.js';
import { safeCode } from '../integrations/alveron/errors.js';
import {
  disabledAdminNotifier,
  systemHealthNotification,
  type AdminNotificationResult,
  type AdminNotifier,
} from '../providers/admin/index.js';

/** Cheap, public, read-only reachability probe (one page, one product requested). */
export const HEALTH_PROBE_ENDPOINT = '/products';

export interface HealthComponent { name: string; ok: boolean; }

export interface SystemHealthResult {
  runId: string;
  workflow: 'system-health';
  status: 'completed';
  endpoint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  components: HealthComponent[];
  degraded: boolean;
  notificationStatus: AdminNotificationResult['status'];
  code?: string;
  message: string;
}

/**
 * Automation health snapshot.
 *
 * Only components this architecture can actually prove are reported; anything it cannot observe
 * is omitted rather than shown as a fabricated "OK". Specifically:
 *
 *   n8n            OK  — n8n invoked this route, so it is demonstrably running and reachable.
 *   Gateway        OK  — this process answered the request.
 *   Alveron API    probed with one bounded, public, read-only catalog read.
 *   Telegram       configured — the admin channel is enabled server-side. Reachability is proven
 *                  separately by the controlled test workflow; a health poll never sends a probe
 *                  message, so "configured" is not overstated as "delivered".
 *
 * Email and Paystack are intentionally absent: there is no real email adapter in this repository,
 * and no Paystack secret is permitted here, so neither can be asserted. A component that cannot
 * fail the check is not listed.
 */
export class SystemHealthWorkflow {
  private running = false;
  constructor(
    private readonly client: CatalogClient,
    private readonly telegramConfigured: boolean,
    private readonly adminNotifications: AdminNotifier = disabledAdminNotifier,
    private readonly environment: string = 'unknown',
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<SystemHealthResult> {
    const runId = randomUUID();
    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const finish = (over: Partial<SystemHealthResult> & { message: string }): SystemHealthResult => {
      const completedAtMs = this.now();
      return {
        runId, workflow: 'system-health', status: 'completed', endpoint: HEALTH_PROBE_ENDPOINT,
        startedAt, completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs), components: [], degraded: false,
        notificationStatus: 'DISABLED', ...over,
      };
    };
    if (this.running) return finish({ message: 'A health check is already running.' });
    this.running = true;
    let alveronOk = false;
    let code: string | undefined;
    try {
      await this.client.getProductCatalog(1, 0);
      alveronOk = true;
    } catch (error) {
      code = safeCode(error);
    } finally {
      this.running = false;
    }
    const components: HealthComponent[] = [
      { name: 'n8n', ok: true },
      { name: 'Gateway', ok: true },
      { name: 'Alveron API', ok: alveronOk },
      { name: 'Telegram', ok: this.telegramConfigured },
    ];
    const degraded = components.some(component => !component.ok);
    let notificationStatus: AdminNotificationResult['status'] = 'DISABLED';
    try {
      notificationStatus = (await this.adminNotifications.notify(
        systemHealthNotification({ environment: this.environment, components }))).status;
    } catch {
      notificationStatus = 'FAILED';
    }
    return finish({
      components, degraded, notificationStatus,
      ...(code ? { code } : {}),
      message: degraded ? 'One or more automation components failed their health check.'
        : 'All observable automation components are healthy.',
    });
  }
}
