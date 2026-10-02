import type { Clock } from './types.ts';

export interface BreakerOptions {
  /** Failures within the window that open the circuit. */
  failureThreshold: number;
  windowMs: number;
  /** How long to fail fast before letting one probe through. */
  cooldownMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

// #region breaker
/**
 * One breaker per provider. While open, calls fail immediately instead of
 * queueing behind a provider that is down, which protects both latency and
 * the shared rate limit. After the cooldown exactly one probe is allowed;
 * its outcome closes or re-opens the circuit.
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly opts: BreakerOptions, private readonly clock: Clock) {}

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.clock.now() - this.openedAt >= this.opts.cooldownMs ? 'half-open' : 'open';
  }

  /** Returns false if the call must not be attempted. */
  tryAcquire(): boolean {
    const s = this.state();
    if (s === 'closed') return true;
    if (s === 'open' || this.probing) return false;
    this.probing = true; // half-open: let a single probe through
    return true;
  }

  onSuccess(): void {
    this.failures = [];
    this.openedAt = null;
    this.probing = false;
  }

  onFailure(): void {
    const now = this.clock.now();
    if (this.probing) {
      this.probing = false;
      this.openedAt = now; // probe failed: back to open, restart cooldown
      return;
    }
    this.failures = this.failures.filter((t) => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.opts.failureThreshold) this.openedAt = now;
  }
}
// #endregion breaker
