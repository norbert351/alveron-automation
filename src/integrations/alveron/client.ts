import { AuthManager } from './auth.js';
import { HttpTransport } from './http.js';
import { AppError } from './errors.js';
import { isId, parseOrder, parseOrders, parseReferralStats, type Order, type ReferralStats } from './schemas.js';
export interface OrderClient { getOrders(): Promise<Order[]>; getOrder(id: string): Promise<Order>; }
export interface ReferralClient { triggerReferralProcessing(): Promise<ReferralStats>; }
export class AlveronClient implements OrderClient, ReferralClient {
  constructor(private readonly http: HttpTransport, private readonly auth: AuthManager) {}
  private async read(path: string): Promise<unknown> {
    let session = await this.auth.getSession();
    try { return await this.http.request('GET', path, session.token); }
    catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 401) throw error;
      session = await this.auth.getSession(session);
      return this.http.request('GET', path, session.token);
    }
  }
  async getOrders(): Promise<Order[]> { return parseOrders(await this.read('/orders')); }
  async getOrder(id: string): Promise<Order> {
    if (!isId(id)) throw new AppError('VALIDATION_FAILED');
    return parseOrder(await this.read(`/orders/${id}`));
  }
  /**
   * Triggers Alveron's OWN referral processing. GET /referrals/admin/stats awaits
   * processPendingReferrals() before responding (verified in Alveron source), and that method
   * processes ALL pending referrals globally. No referral rules are implemented here.
   * NOTE: Alveron wraps the call in .catch(() => undefined), so a 200 response proves the
   * endpoint executed but NOT that processing succeeded, and reports no processed count.
   */
  async triggerReferralProcessing(): Promise<ReferralStats> {
    return parseReferralStats(await this.read('/referrals/admin/stats'));
  }
}
