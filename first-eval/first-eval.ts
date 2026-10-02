import { readFileSync } from 'node:fs';

// #region case
/** One test case: a real question and what a good answer must, and must not, say. */
export interface Case {
  id: string;
  question: string;
  mustInclude: string[];
  mustNotInclude?: string[];
}
// #endregion case

export interface Result {
  id: string;
  pass: boolean;
  why: string[];
  answer: string;
}

// #region run
/**
 * The whole first eval: ask every question, check every answer, report.
 * `answer` is your system, whatever it is: a prompt and a model call,
 * a RAG pipeline, an existing endpoint. Nothing here depends on how it works.
 */
export async function runCases(cases: Case[], answer: (question: string) => Promise<string>): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of cases) {
    const text = await answer(c.question);
    const lower = text.toLowerCase();
    const why = [
      ...c.mustInclude.filter((s) => !lower.includes(s.toLowerCase())).map((s) => `saknar "${s}"`),
      ...(c.mustNotInclude ?? []).filter((s) => lower.includes(s.toLowerCase())).map((s) => `innehåller "${s}"`),
    ];
    results.push({ id: c.id, pass: why.length === 0, why, answer: text });
  }
  return results;
}
// #endregion run

// #region compare
/** What got worse since last time: the question to ask before every change ships. */
export function compare(before: Result[], after: Result[]) {
  const was = new Map(before.map((r) => [r.id, r.pass]));
  return {
    passRate: after.filter((r) => r.pass).length / Math.max(1, after.length),
    newlyFailing: after.filter((r) => was.get(r.id) === true && !r.pass).map((r) => r.id),
    newlyPassing: after.filter((r) => was.get(r.id) === false && r.pass).map((r) => r.id),
  };
}
// #endregion compare

export function loadCases(path: string): Case[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Case);
}
