// #region metrics
/** Share of relevant ids that appear in the top k results. */
export function recallAtK(retrieved: number[], relevant: Set<number>, k: number): number {
  if (relevant.size === 0) return 1;
  const top = retrieved.slice(0, k);
  return top.filter((id) => relevant.has(id)).length / relevant.size;
}

/** 1 / rank of the first relevant result, 0 if none. Rewards getting it first. */
export function reciprocalRank(retrieved: number[], relevant: Set<number>): number {
  const i = retrieved.findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** Mean over a set of labelled queries. */
export function evaluateRetrieval(
  runs: Array<{ retrieved: number[]; relevant: Set<number> }>,
  k: number,
): { recall: number; mrr: number } {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    recall: mean(runs.map((r) => recallAtK(r.retrieved, r.relevant, k))),
    mrr: mean(runs.map((r) => reciprocalRank(r.retrieved, r.relevant))),
  };
}
// #endregion metrics
