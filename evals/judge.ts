import type { EvalCase } from './dataset.ts';
import type { Score, Scorer } from './scorers.ts';

/** Any function that sends a prompt to a model and returns its text. */
export type Complete = (system: string, user: string) => Promise<string>;

// #region judge
/**
 * LLM-as-judge for criteria that code cannot check ("is the tone polite",
 * "does the answer stay within the policy"). The judge answers in strict
 * JSON with a verdict and a reason; anything else counts as a failed
 * judgement, never as a pass.
 */
export function llmJudge(complete: Complete, rubric: string): Scorer {
  const system = [
    'You are grading the output of another system against a rubric.',
    'Respond with JSON only: {"reason": string, "verdict": "pass" | "fail"}.',
    'Write the reason first, then the verdict. Grade strictly; if unsure, fail.',
  ].join('\n');
  return async (output: string, c: EvalCase): Promise<Score> => {
    const user = `Rubric:\n${rubric}\n\nInput:\n${c.input}\n\nOutput to grade:\n${output}`;
    const raw = await complete(system, user);
    return parseVerdict(raw);
  };
}

export function parseVerdict(raw: string): Score {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const v = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
    if ((v.verdict === 'pass' || v.verdict === 'fail') && typeof v.reason === 'string') {
      return { pass: v.verdict === 'pass', reason: `judge: ${v.reason}` };
    }
  } catch { /* fall through */ }
  return { pass: false, reason: 'judge returned an unparseable verdict' };
}
// #endregion judge

// #region calibration
/**
 * Before a judge is allowed to gate releases, compare it with human labels
 * on the same outputs. Raw agreement is misleading when most outputs pass,
 * so we also report Cohen's kappa, which corrects for chance agreement.
 */
export function agreement(human: boolean[], judge: boolean[]): { accuracy: number; kappa: number; n: number } {
  if (human.length !== judge.length || human.length === 0) throw new Error('label arrays must be non-empty and equal length');
  const n = human.length;
  let both = 0, neither = 0, h = 0, j = 0;
  for (let i = 0; i < n; i++) {
    if (human[i]) h++;
    if (judge[i]) j++;
    if (human[i] && judge[i]) both++;
    if (!human[i] && !judge[i]) neither++;
  }
  const po = (both + neither) / n;
  const pe = (h / n) * (j / n) + ((n - h) / n) * ((n - j) / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { accuracy: po, kappa, n };
}
// #endregion calibration
