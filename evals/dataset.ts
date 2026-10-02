// #region case
export interface EvalCase {
  /** Stable id. Never reuse an id for a different case: history depends on it. */
  id: string;
  input: string;
  /** Reference answer or structured expectation, depending on the scorer. */
  expected?: unknown;
  /** e.g. ["billing", "swedish", "critical"]. Drives per-slice reporting. */
  tags: string[];
}
// #endregion case

// #region load
/**
 * Datasets live in the repository as JSONL, one case per line, reviewed in
 * pull requests like code. Loading is strict: a malformed line fails the
 * run instead of silently shrinking the suite.
 */
export function parseJsonl(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: invalid JSON`); }
    const c = raw as Partial<EvalCase>;
    if (typeof c.id !== 'string' || !c.id) throw new Error(`line ${i + 1}: missing id`);
    if (typeof c.input !== 'string') throw new Error(`line ${i + 1} (${c.id}): missing input`);
    if (c.tags !== undefined && !(Array.isArray(c.tags) && c.tags.every((t) => typeof t === 'string'))) {
      throw new Error(`line ${i + 1} (${c.id}): tags must be strings`);
    }
    if (seen.has(c.id)) throw new Error(`line ${i + 1}: duplicate id ${c.id}`);
    seen.add(c.id);
    cases.push({ id: c.id, input: c.input, expected: c.expected, tags: c.tags ?? [] });
  });
  return cases;
}
// #endregion load
