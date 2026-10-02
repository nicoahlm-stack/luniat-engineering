import { createHash } from 'node:crypto';

// #region cache-key
/** JSON with sorted keys, so {a, b} and {b, a} produce the same key. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * A cached model response may only be served to the tenant that produced it.
 * The tenant is a prefix (so a tenant's entries can be listed and purged),
 * and everything that can change the output is inside the hash.
 */
export function responseCacheKey(k: { tenantId: string; model: string; promptHash: string; inputs: Record<string, unknown> }): string {
  const digest = createHash('sha256').update(canonicalJson({ model: k.model, promptHash: k.promptHash, inputs: k.inputs })).digest('hex');
  return `llm:v1:${k.tenantId}:${digest}`;
}
// #endregion cache-key
