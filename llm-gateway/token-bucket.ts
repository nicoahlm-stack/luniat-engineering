import type { Clock } from './types.ts';

export interface BucketOptions {
  /** Maximum tokens a tenant can spend in a burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

// #region bucket
/**
 * Token bucket measured in model tokens, not requests: one request with a
 * 200k-token context costs the provider far more than ten short ones, and
 * the provider's own limits are in tokens per minute.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly opts: BucketOptions, private readonly clock: Clock) {
    this.tokens = opts.capacity;
    this.updatedAt = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const added = ((now - this.updatedAt) / 1000) * this.opts.refillPerSecond;
    this.tokens = Math.min(this.opts.capacity, this.tokens + added);
    this.updatedAt = now;
  }

  /** Takes `cost` tokens if available. Never blocks. */
  tryTake(cost: number): boolean {
    this.refill();
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }

  /** Returns tokens when the real usage was lower than the estimate. */
  refund(amount: number): void {
    this.refill();
    this.tokens = Math.min(this.opts.capacity, this.tokens + amount);
  }

  /** Milliseconds until `cost` tokens are available, for a Retry-After header. */
  waitTimeMs(cost: number): number {
    this.refill();
    if (cost <= this.tokens) return 0;
    return Math.ceil(((cost - this.tokens) / this.opts.refillPerSecond) * 1000);
  }
}
// #endregion bucket

// #region tenants
/** One bucket per tenant, so a single tenant can never drain the shared quota. */
export class TenantLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly optsFor: (tenantId: string) => BucketOptions,
    private readonly clock: Clock,
  ) {}

  bucket(tenantId: string): TokenBucket {
    let b = this.buckets.get(tenantId);
    if (!b) {
      b = new TokenBucket(this.optsFor(tenantId), this.clock);
      this.buckets.set(tenantId, b);
    }
    return b;
  }
}
// #endregion tenants
