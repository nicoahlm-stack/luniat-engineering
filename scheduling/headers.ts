// #region headers
export interface QuotaSnapshot {
  limit?: number;
  remaining: number;
  /** Milliseconds until the window resets, relative to when the response was received. */
  resetMs: number;
}

/** "1s", "6m0s", "250ms", "1h2m3.5s" → milliseconds. */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0, matched = '';
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1_000 : n;
    matched += m[0];
  }
  return matched === s.trim() && matched ? Math.round(total) : undefined;
}

/**
 * Providers report quota in different dialects. Read what is there instead of
 * hard-coding limits, because limits change with your account tier and differ
 * between models. Supports:
 *   - the IETF draft field:   RateLimit: "default";r=12;t=30
 *   - common vendor headers:  x-ratelimit-remaining-tokens / x-ratelimit-reset-tokens
 *   - classic headers:        X-RateLimit-Remaining / X-RateLimit-Reset (seconds or epoch)
 * Returns the most restrictive quota found, or undefined if there is none.
 */
export function parseQuota(headers: Headers, nowMs: number, unit: 'requests' | 'tokens' = 'tokens'): QuotaSnapshot | undefined {
  const found: QuotaSnapshot[] = [];

  const draft = headers.get('ratelimit');
  if (draft) {
    for (const item of draft.split(',')) {
      const r = item.match(/;\s*r=(\d+)/), t = item.match(/;\s*t=(\d+)/);
      if (r && t) found.push({ remaining: Number(r[1]), resetMs: Number(t[1]) * 1000 });
    }
  }

  const rem = headers.get(`x-ratelimit-remaining-${unit}`);
  const reset = headers.get(`x-ratelimit-reset-${unit}`);
  if (rem !== null && reset !== null) {
    const ms = parseDuration(reset);
    if (ms !== undefined) {
      const lim = headers.get(`x-ratelimit-limit-${unit}`);
      found.push({ remaining: Number(rem), resetMs: ms, ...(lim !== null ? { limit: Number(lim) } : {}) });
    }
  }

  const cRem = headers.get('x-ratelimit-remaining'), cReset = headers.get('x-ratelimit-reset');
  if (cRem !== null && cReset !== null) {
    const v = Number(cReset);
    // Large values are epoch seconds; small ones are seconds until reset.
    const resetMs = v > 1e9 ? Math.max(0, v * 1000 - nowMs) : v * 1000;
    const lim = headers.get('x-ratelimit-limit');
    found.push({ remaining: Number(cRem), resetMs, ...(lim !== null ? { limit: Number(lim) } : {}) });
  }

  return found.filter((q) => Number.isFinite(q.remaining) && Number.isFinite(q.resetMs))
    .sort((a, b) => a.remaining - b.remaining)[0];
}
// #endregion headers
