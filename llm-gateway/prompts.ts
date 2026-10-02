import { createHash } from 'node:crypto';
import type { RenderedPrompt } from './types.ts';

export interface PromptTemplate {
  id: string;
  version: number;
  system: string;
  /** User template with {{variable}} placeholders. */
  user: string;
}

const VAR = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// #region registry
/**
 * Prompts are code: versioned, reviewed and immutable once published.
 * Every rendered prompt carries id, version and a content hash, so a log
 * line or an eval result can always be traced to the exact text sent.
 */
export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate & { hash: string }>();

  register(t: PromptTemplate): void {
    const key = `${t.id}@${t.version}`;
    const hash = createHash('sha256').update(`${t.system}\u0000${t.user}`).digest('hex');
    const existing = this.templates.get(key);
    if (existing && existing.hash !== hash) {
      throw new Error(`${key} is already registered with different content; bump the version`);
    }
    this.templates.set(key, { ...t, hash });
  }

  render(id: string, version: number, vars: Record<string, string>): RenderedPrompt {
    const t = this.templates.get(`${id}@${version}`);
    if (!t) throw new Error(`unknown prompt ${id}@${version}`);
    const needed = new Set([...t.user.matchAll(VAR)].map((m) => m[1]!));
    const missing = [...needed].filter((k) => !(k in vars));
    const extra = Object.keys(vars).filter((k) => !needed.has(k));
    if (missing.length || extra.length) {
      throw new Error(`prompt ${id}@${version}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`);
    }
    const user = t.user.replace(VAR, (_, k: string) => vars[k]!);
    return { id, version, hash: t.hash, system: t.system, user };
  }
}
// #endregion registry
