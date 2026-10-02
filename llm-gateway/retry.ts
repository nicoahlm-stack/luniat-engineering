import { RetryableError, type Clock } from './types.ts';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// #region backoff
/**
 * "Full jitter" exponential backoff: a random delay between 0 and
 * min(cap, base * 2^attempt). Spreads retries from many clients so they
 * do not hit the provider in synchronised waves after an outage.
 */
export function backoffDelay(attempt: number, p: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
// #endregion backoff

// #region retry
/**
 * Retries only RetryableError. A Retry-After from the provider wins over
 * our own backoff, because the provider knows when capacity returns.
 * Gives up early if the remaining deadline cannot fit the next wait.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
  deadline: number,
  signal: AbortSignal,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const last = attempt + 1 >= policy.maxAttempts;
      if (!(err instanceof RetryableError) || last) throw err;
      const wait = err.retryAfterMs ?? backoffDelay(attempt, policy, random);
      if (clock.now() + wait >= deadline) throw err;
      await clock.sleep(wait, signal);
    }
  }
}
// #endregion retry
