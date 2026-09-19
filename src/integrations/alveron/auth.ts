import { AppError } from './errors.js';
import type { HttpTransport } from './http.js';
import type { Logger } from './logger.js';

export interface AccessSession { token: string; expiresAt: number; }
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class AuthManager {
  private current?: AccessSession;
  private pending?: Promise<AccessSession>;
  constructor(private readonly http: HttpTransport, private readonly logger: Logger, private readonly now = Date.now) {}

  getSession(rejected?: AccessSession): Promise<AccessSession> {
    // Compare session identity, not token text: a late 401 cannot evict a newer login.
    if (rejected && this.current === rejected) this.current = undefined;
    if (this.current && this.current.expiresAt > this.now() + 1000) return Promise.resolve(this.current);
    if (this.pending) return this.pending;
    this.pending = this.login().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async login(): Promise<AccessSession> {
    const startedAt = this.now();
    try {
      const value = record(await this.http.request('POST', '/auth/admin-login'));
      const session = record(value['session']);
      const employee = record(value['employee']);
      const role = record(employee['role']);
      const profile = record(value['profile']);
      const token = session['access_token'];
      const at = session['expires_at'];
      const duration = session['expires_in'];
      const expiries: number[] = [];
      if (at !== undefined) {
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) throw new Error();
        expiries.push(at * 1000);
      }
      if (duration !== undefined) {
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error();
        expiries.push(startedAt + duration * 1000);
      }
      const expiresAt = Math.min(...expiries);
      if (typeof token !== 'string' || !token || token.length > 16384 || /\s/.test(token) ||
          !expiries.length || !Number.isFinite(expiresAt) || expiresAt <= this.now() + 1000 ||
          employee['status'] !== 'active' || role['slug'] !== 'admin' || profile['role'] !== 'admin' ||
          (profile['status'] !== undefined && profile['status'] !== 'active') || value['mustChangePassword'] === true) {
        throw new Error();
      }
      this.current = { token, expiresAt };
      this.logger.log('auth_success');
      return this.current;
    } catch {
      this.logger.log('auth_failure', { code: 'AUTHENTICATION_FAILED' });
      throw new AppError('AUTHENTICATION_FAILED');
    }
  }
}
