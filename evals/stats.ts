// #region wilson
/**
 * Wilson score interval for a pass rate. Unlike the naive p ± 1.96·√(p(1-p)/n)
 * it behaves at small n and near 0 or 1, which is exactly where eval suites
 * live (n = 200, pass rate 0.97).
 */
export function wilson(passes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = passes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
// #endregion wilson

// #region mcnemar
/**
 * Exact McNemar test for paired results: the same cases, run on the baseline
 * and on the candidate. Only discordant pairs carry information:
 *   b = passed before, fails now (regressions)
 *   c = failed before, passes now (fixes)
 * Under "no difference", b ~ Binomial(b + c, 0.5). Returns the one-sided
 * p-value for "the candidate is worse".
 */
export function mcnemarWorse(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  // P(X >= b) for X ~ Bin(n, 0.5), summed in log space to avoid overflow.
  let p = 0;
  for (let k = b; k <= n; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, p);
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
// #endregion mcnemar
