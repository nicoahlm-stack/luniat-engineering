import type { Hit } from './search.ts';

// #region context
export interface Source {
  n: number;
  chunkId: number;
  documentId: number;
  heading: string;
  body: string;
}

/**
 * Packs retrieved chunks into the prompt, best first, until the token budget
 * is spent. Each chunk gets a number the model must cite, and the text is
 * fenced so the model can tell retrieved data from instructions.
 */
export function buildContext(hits: Hit[], budgetTokens: number): { text: string; sources: Source[] } {
  const sources: Source[] = [];
  let used = 0;
  for (const h of hits) {
    const cost = Math.ceil((h.heading.length + h.body.length) / 4) + 12;
    if (used + cost > budgetTokens) break;
    used += cost;
    sources.push({ n: sources.length + 1, chunkId: h.id, documentId: h.documentId, heading: h.heading, body: h.body });
  }
  const text = sources
    .map((s) => `<source n="${s.n}" title="${s.heading.replace(/"/g, "'")}">\n${s.body}\n</source>`)
    .join('\n');
  return { text, sources };
}
// #endregion context

// #region citations
/**
 * Checks an answer against the sources it was given. An answer that cites a
 * source that was never provided is a hallucinated citation and fails; an
 * answer with no citations at all fails unless it says it cannot answer.
 */
export function checkCitations(answer: string, sources: Source[], refusal = /i (?:do not|don't) know|cannot find/i) {
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const valid = new Set(sources.map((s) => s.n));
  const invalid = [...new Set(cited.filter((n) => !valid.has(n)))];
  const ok = invalid.length === 0 && (cited.length > 0 || refusal.test(answer));
  return { ok, cited: [...new Set(cited)], invalid };
}
// #endregion citations
