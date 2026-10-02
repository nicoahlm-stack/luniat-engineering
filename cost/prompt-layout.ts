import { createHash } from 'node:crypto';

// #region layout
/**
 * Provider prompt caches match on an exact prefix. Order the prompt from the
 * most stable part to the most volatile, so the long stable part is shared by
 * every request: instructions, then tool definitions, then reference material
 * that changes daily, then the conversation, then the new question.
 */
export interface PromptParts {
  instructions: string;
  tools: string;
  reference: string;
  history: string;
  question: string;
}

export function layout(p: PromptParts): { prefix: string; suffix: string; prefixHash: string } {
  const prefix = [p.instructions, p.tools, p.reference].join('\n\n');
  const suffix = [p.history, p.question].filter(Boolean).join('\n\n');
  return { prefix, suffix, prefixHash: createHash('sha256').update(prefix).digest('hex').slice(0, 16) };
}

/**
 * Finds values that change on every request and silently defeat the cache
 * when they end up in the stable prefix: timestamps, dates, UUIDs, request ids.
 */
export function volatileTokens(prefix: string): string[] {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/g,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    /\b(?:req|trace|request)[_-]?id[:=]\s*\S+/gi,
  ];
  return patterns.flatMap((re) => prefix.match(re) ?? []);
}
// #endregion layout
