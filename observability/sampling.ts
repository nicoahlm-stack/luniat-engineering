import { createHash } from 'node:crypto';

// #region sampling
export interface TraceSummary {
  traceId: string;
  durationMs: number;
  error: boolean;
  /** Set by product code: thumbs-down, policy denial, failed citation check. */
  flagged: boolean;
  tenantId: string;
}

/**
 * Tail-based sampling: decide after the trace is complete, so every
 * interesting trace is kept and the boring majority is sampled. The random
 * part is a hash of the trace id, so every service that sees the same trace
 * makes the same decision without coordinating.
 */
export function keepTrace(t: TraceSummary, o: { slowMs: number; baseRate: number; tenantRate?: (tenant: string) => number }):
  { keep: boolean; reason: 'error' | 'flagged' | 'slow' | 'sampled' | 'dropped' } {
  if (t.error) return { keep: true, reason: 'error' };
  if (t.flagged) return { keep: true, reason: 'flagged' };
  if (t.durationMs >= o.slowMs) return { keep: true, reason: 'slow' };
  const rate = o.tenantRate?.(t.tenantId) ?? o.baseRate;
  const bucket = createHash('sha256').update(t.traceId).digest().readUInt32BE(0) / 0xffffffff;
  return bucket < rate ? { keep: true, reason: 'sampled' } : { keep: false, reason: 'dropped' };
}
// #endregion sampling
