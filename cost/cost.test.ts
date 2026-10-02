import { describe, expect, it } from 'vitest';
import { budgetState } from './budget.ts';
import { costUsd, type Price } from './pricing.ts';
import { layout, volatileTokens } from './prompt-layout.ts';
import { chooseRoute, type RouteStats } from './router.ts';

// Illustrative prices in USD per million tokens. Not any provider's actual prices.
const large: Price = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, batchFactor: 0.5 };

describe('pricing', () => {
  it('prices cache reads, writes and batch separately', () => {
    // 20k-token stable prefix, 500 new input tokens, 300 output tokens.
    const first = costUsd({ input: 500, cacheWrite: 20_000, output: 300 }, large);
    const repeat = costUsd({ input: 500, cacheRead: 20_000, output: 300 }, large);
    const uncached = costUsd({ input: 20_500, output: 300 }, large);
    expect(first).toBeCloseTo(0.081, 6);
    expect(repeat).toBeCloseTo(0.012, 6);
    expect(uncached).toBeCloseTo(0.066, 6);
    expect(costUsd({ input: 20_500, output: 300 }, large, { batch: true })).toBeCloseTo(0.033, 6);
  });
});

describe('prompt layout', () => {
  const parts = { instructions: 'You answer support questions for Acme.', tools: '[tool schemas]', reference: 'Policy v12 …', history: 'User: hi', question: 'Where is my order?' };

  it('keeps the prefix stable when only the volatile parts change', () => {
    expect(layout(parts).prefixHash).toBe(layout({ ...parts, history: '', question: 'Can I return it?' }).prefixHash);
    expect(layout(parts).prefixHash).not.toBe(layout({ ...parts, reference: 'Policy v13 …' }).prefixHash);
  });

  it('flags values that defeat caching when placed in the prefix', () => {
    const p = layout({ ...parts, instructions: `Current time: 2026-10-02 09:14:03. request_id=ab12cd. ${parts.instructions}` }).prefix;
    expect(volatileTokens(p)).toEqual(['2026-10-02 09:14:03', 'request_id=ab12cd.']);
    expect(volatileTokens(layout(parts).prefix)).toEqual([]);
  });
});

describe('routing', () => {
  const stats: RouteStats[] = [
    { route: 'large', task: 'classify', passRate: 0.97, passRateLow: 0.94, p95LatencyMs: 2_400, costPerCallUsd: 0.004 },
    { route: 'small', task: 'classify', passRate: 0.96, passRateLow: 0.93, p95LatencyMs: 700, costPerCallUsd: 0.0004 },
    { route: 'tiny', task: 'classify', passRate: 0.95, passRateLow: 0.78, p95LatencyMs: 300, costPerCallUsd: 0.0001 },
    { route: 'large', task: 'draft-reply', passRate: 0.92, passRateLow: 0.88, p95LatencyMs: 6_000, costPerCallUsd: 0.02 },
    { route: 'small', task: 'draft-reply', passRate: 0.81, passRateLow: 0.76, p95LatencyMs: 2_000, costPerCallUsd: 0.002 },
  ];

  it('picks the cheapest route that clears the bar on its lower bound', () => {
    expect(chooseRoute(stats, 'classify', { minPassRate: 0.9, maxP95LatencyMs: 3_000 })).toEqual({ route: 'small', costPerCallUsd: 0.0004 });
    expect(chooseRoute(stats, 'draft-reply', { minPassRate: 0.85, maxP95LatencyMs: 8_000 })).toEqual({ route: 'large', costPerCallUsd: 0.02 });
  });

  it('refuses to guess when nothing qualifies', () => {
    expect(chooseRoute(stats, 'draft-reply', { minPassRate: 0.85, maxP95LatencyMs: 3_000 }).route).toBeNull();
    expect(chooseRoute(stats, 'translate', { minPassRate: 0.5, maxP95LatencyMs: 9_999 })).toEqual({ route: null, reason: 'no measurements for task translate' });
  });
});

describe('tenant budgets', () => {
  const policy = { monthlyUsd: 300, warnAt: 0.7, degradeAt: 0.9 };
  it('warns early from the burn rate, then degrades and stops', () => {
    expect(budgetState(50, policy, 10, 30)).toEqual({ state: 'ok', projectedUsd: 150 });
    expect(budgetState(120, policy, 10, 30)).toEqual({ state: 'warn', projectedUsd: 360 });
    expect(budgetState(275, policy, 25, 30).state).toBe('degrade');
    expect(budgetState(301, policy, 28, 30).state).toBe('stop');
  });
});
