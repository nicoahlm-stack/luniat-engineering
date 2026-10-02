import type { EvalCase } from './dataset.ts';
import { scoreAll, type Score, type Scorer } from './scorers.ts';
import { mcnemarWorse, wilson } from './stats.ts';

/** The system under test: prompt + model + retrieval + post-processing. */
export type System = (input: string) => Promise<string>;

export interface CaseResult extends Score {
  id: string;
  tags: string[];
  output: string;
}

// #region run
/**
 * Runs every case with bounded concurrency. Bounded, because the eval run
 * shares rate limits with production traffic on the same API key.
 */
export async function runSuite(cases: EvalCase[], system: System, scorers: Scorer[], concurrency = 4): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i]!;
      let output = '';
      let score: Score;
      try {
        output = await system(c.input);
        score = await scoreAll(output, c, scorers);
      } catch (err) {
        // A crash is a failure of the system under test, not of the harness.
        score = { pass: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` };
      }
      results[i] = { id: c.id, tags: c.tags, output, ...score };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}
// #endregion run

// #region gate
export interface GatePolicy {
  /** Cases with this tag must pass on the candidate if they passed on the baseline. */
  criticalTag: string;
  /** Block if the candidate is significantly worse at this level. */
  alpha: number;
  /** Block if the overall pass rate drops by more than this, significant or not. */
  maxDrop: number;
}

export interface GateDecision {
  pass: boolean;
  reasons: string[];
  baseline: { rate: number; low: number; high: number };
  candidate: { rate: number; low: number; high: number };
  regressions: string[];
  fixes: string[];
  pValue: number;
}

/**
 * Compares a candidate run with the baseline run on the same cases.
 * Three independent reasons to block a release:
 *   1. any critical case regressed,
 *   2. the candidate is significantly worse (paired McNemar test),
 *   3. the pass rate fell more than the allowed margin.
 */
export function gate(baseline: CaseResult[], candidate: CaseResult[], policy: GatePolicy): GateDecision {
  const before = new Map(baseline.map((r) => [r.id, r]));
  const regressions: string[] = [], fixes: string[] = [], criticalRegressions: string[] = [];
  for (const r of candidate) {
    const b = before.get(r.id);
    if (!b) continue; // new case: no baseline to compare with
    if (b.pass && !r.pass) {
      regressions.push(r.id);
      if (r.tags.includes(policy.criticalTag)) criticalRegressions.push(r.id);
    }
    if (!b.pass && r.pass) fixes.push(r.id);
  }
  const rate = (rs: CaseResult[]) => {
    const passes = rs.filter((r) => r.pass).length;
    return { rate: rs.length ? passes / rs.length : 0, ...wilson(passes, rs.length) };
  };
  const base = rate(baseline), cand = rate(candidate);
  const pValue = mcnemarWorse(regressions.length, fixes.length);

  const reasons: string[] = [];
  if (criticalRegressions.length) reasons.push(`critical cases regressed: ${criticalRegressions.join(', ')}`);
  if (pValue < policy.alpha) reasons.push(`significantly worse (McNemar p = ${pValue.toFixed(4)})`);
  if (base.rate - cand.rate > policy.maxDrop) reasons.push(`pass rate fell ${((base.rate - cand.rate) * 100).toFixed(1)} points`);
  return { pass: reasons.length === 0, reasons, baseline: base, candidate: cand, regressions, fixes, pValue };
}
// #endregion gate
