import type { EvalCase } from './dataset.ts';

export interface Score {
  pass: boolean;
  /** Human-readable reason, shown in the CI report for failures. */
  reason: string;
}

export type Scorer = (output: string, c: EvalCase) => Score | Promise<Score>;
/** Deterministic scorers are synchronous: no model, no network, no flakiness. */
export type SyncScorer = (output: string, c: EvalCase) => Score;

// #region deterministic
const normalise = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** For classification-style tasks with a single correct label. */
export const exactLabel: SyncScorer = (output, c) => {
  const ok = normalise(output) === normalise(String(c.expected));
  return { pass: ok, reason: ok ? 'label matches' : `expected "${String(c.expected)}", got "${output.slice(0, 80)}"` };
};

/**
 * For extraction: the output must be JSON, and every expected field must
 * match. Extra fields are allowed; missing or wrong ones are named.
 */
export const jsonFields: SyncScorer = (output, c) => {
  let parsed: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(output);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { pass: false, reason: 'output is not a JSON object' };
    parsed = v as Record<string, unknown>;
  } catch {
    return { pass: false, reason: 'output is not valid JSON' };
  }
  const expected = (c.expected ?? {}) as Record<string, unknown>;
  const wrong = Object.entries(expected)
    .filter(([k, v]) => JSON.stringify(parsed[k]) !== JSON.stringify(v))
    .map(([k]) => k);
  return wrong.length ? { pass: false, reason: `wrong or missing: ${wrong.join(', ')}` } : { pass: true, reason: 'all fields match' };
};

/** Hard constraints that must hold whatever the content, e.g. "never mention a price". */
export function forbids(pattern: RegExp, label: string): SyncScorer {
  return (output) => (pattern.test(output) ? { pass: false, reason: `contains ${label}` } : { pass: true, reason: `no ${label}` });
}
// #endregion deterministic

// #region all
/** A case passes only if every scorer passes. Reasons are kept for the report. */
export async function scoreAll(output: string, c: EvalCase, scorers: Scorer[]): Promise<Score> {
  const results = await Promise.all(scorers.map((s) => s(output, c)));
  const failed = results.filter((r) => !r.pass);
  return failed.length ? { pass: false, reason: failed.map((r) => r.reason).join('; ') } : { pass: true, reason: 'ok' };
}
// #endregion all
