// #region router
/** Measured per task and route by the eval suite, not estimated. */
export interface RouteStats {
  route: string;
  task: string;
  passRate: number;
  /** Lower bound of the pass rate's confidence interval. */
  passRateLow: number;
  p95LatencyMs: number;
  costPerCallUsd: number;
}

export interface TaskPolicy {
  minPassRate: number;
  maxP95LatencyMs: number;
}

/**
 * Picks the cheapest route that meets the task's quality and latency bars.
 * Uses the lower bound of the pass rate, so a route that scored well on a
 * handful of cases does not win on luck. Returns the reason when nothing
 * qualifies, instead of silently picking the "best available".
 */
export function chooseRoute(stats: RouteStats[], task: string, policy: TaskPolicy):
  { route: string; costPerCallUsd: number } | { route: null; reason: string } {
  const candidates = stats.filter((s) => s.task === task);
  if (!candidates.length) return { route: null, reason: `no measurements for task ${task}` };
  const ok = candidates
    .filter((s) => s.passRateLow >= policy.minPassRate && s.p95LatencyMs <= policy.maxP95LatencyMs)
    .sort((a, b) => a.costPerCallUsd - b.costPerCallUsd);
  if (!ok.length) return { route: null, reason: `no route meets pass rate ≥ ${policy.minPassRate} and p95 ≤ ${policy.maxP95LatencyMs} ms` };
  return { route: ok[0]!.route, costPerCallUsd: ok[0]!.costPerCallUsd };
}
// #endregion router
