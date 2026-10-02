import type { QuotaSnapshot } from './headers.ts';

// #region adaptive
/**
 * Paces outgoing calls from what the provider says is left. Keeps a reserve
 * so interactive traffic still has headroom when batch work is running, and
 * stops completely until the reset when the provider returns 429.
 */
export class AdaptiveThrottle {
  private remaining = Number.POSITIVE_INFINITY;
  private resetAt = 0;
  private pausedUntil = 0;
  private limit = 0;

  constructor(private readonly reserveFraction: number, private readonly now: () => number = Date.now) {}

  observe(q: QuotaSnapshot, limitHint?: number): void {
    this.remaining = q.remaining;
    this.resetAt = this.now() + q.resetMs;
    const limit = q.limit ?? limitHint;
    if (limit) this.limit = limit;
  }

  onTooManyRequests(retryAfterMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
    this.remaining = 0;
  }

  /**
   * Can a call of this cost start now? `priority: 'interactive'` may use the
   * reserve; batch work may not.
   */
  canStart(cost: number, priority: 'interactive' | 'batch'): { ok: true } | { ok: false; waitMs: number } {
    const now = this.now();
    if (now < this.pausedUntil) return { ok: false, waitMs: this.pausedUntil - now };
    if (now >= this.resetAt) this.remaining = Number.POSITIVE_INFINITY; // window rolled over; trust the next response
    const reserve = priority === 'batch' ? Math.ceil(this.limit * this.reserveFraction) : 0;
    if (this.remaining - cost >= reserve) {
      this.remaining -= cost; // optimistic local accounting until the next response corrects it
      return { ok: true };
    }
    return { ok: false, waitMs: Math.max(0, this.resetAt - now) };
  }
}
// #endregion adaptive
