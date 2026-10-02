// #region histogram
/**
 * Fixed-bucket histogram for latency. Buckets are chosen for LLM traffic,
 * where p99 is often ten times the median: fine-grained under a second for
 * time to first token, coarse up to a minute for full generations.
 */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 750, 1_000, 1_500, 2_500, 5_000, 10_000, 20_000, 40_000, 60_000];

export class Histogram {
  readonly counts: number[];
  count = 0;
  sum = 0;

  constructor(readonly bounds: number[] = LATENCY_BUCKETS_MS) {
    this.counts = new Array(bounds.length + 1).fill(0);
  }

  record(v: number): void {
    let i = this.bounds.findIndex((b) => v <= b);
    if (i === -1) i = this.bounds.length; // overflow bucket
    this.counts[i]!++;
    this.count++;
    this.sum += v;
  }

  /**
   * Quantile estimate by linear interpolation inside the bucket, the same
   * method Prometheus uses for histogram_quantile. Accurate to the bucket
   * width, which is why the bucket layout matters.
   */
  quantile(q: number): number {
    if (!this.count) return NaN;
    const rank = q * this.count;
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i]!;
      if (seen + c >= rank && c > 0) {
        const lo = i === 0 ? 0 : this.bounds[i - 1]!;
        const hi = this.bounds[i] ?? this.bounds[this.bounds.length - 1]!;
        return lo + ((hi - lo) * (rank - seen)) / c;
      }
      seen += c;
    }
    return this.bounds[this.bounds.length - 1]!;
  }
}
// #endregion histogram
