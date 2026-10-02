// #region pricing
/**
 * Prices per million tokens, per route. The numbers in tests are illustrative;
 * real prices change and belong in configuration, not in code. Cached input is
 * split into writes (first time a prefix is cached) and reads (later hits),
 * because providers price them differently.
 */
export interface Price {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Multiplier for asynchronous batch processing, e.g. 0.5. */
  batchFactor?: number;
}

export interface Usage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export function costUsd(u: Usage, p: Price, opts: { batch?: boolean } = {}): number {
  const raw =
    u.input * p.input +
    u.output * p.output +
    (u.cacheWrite ?? 0) * (p.cacheWrite ?? p.input) +
    (u.cacheRead ?? 0) * (p.cacheRead ?? p.input);
  return (raw / 1e6) * (opts.batch ? p.batchFactor ?? 1 : 1);
}
// #endregion pricing
