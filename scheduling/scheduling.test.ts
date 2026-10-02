import { describe, expect, it } from 'vitest';
import { AdaptiveThrottle } from './adaptive.ts';
import { FairQueue, type Job } from './fair-queue.ts';
import { parseDuration, parseQuota } from './headers.ts';

describe('quota headers', () => {
  it('parses Go-style durations', () => {
    expect(parseDuration('6m0s')).toBe(360_000);
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('soon')).toBeUndefined();
  });

  it('reads vendor, draft and classic dialects and returns the most restrictive', () => {
    const now = 1_800_000_000_000;
    expect(parseQuota(new Headers({ 'x-ratelimit-limit-tokens': '400000', 'x-ratelimit-remaining-tokens': '12000', 'x-ratelimit-reset-tokens': '1m30s' }), now))
      .toEqual({ limit: 400_000, remaining: 12_000, resetMs: 90_000 });
    expect(parseQuota(new Headers({ ratelimit: '"tokens";r=5000;t=20' }), now)).toEqual({ remaining: 5_000, resetMs: 20_000 });
    expect(parseQuota(new Headers({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(now / 1000 + 45) }), now)).toEqual({ remaining: 3, resetMs: 45_000 });
    expect(parseQuota(new Headers({ ratelimit: '"tokens";r=5000;t=20', 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '10' }), now)?.remaining).toBe(7);
    expect(parseQuota(new Headers({}), now)).toBeUndefined();
  });
});

describe('adaptive throttle', () => {
  it('keeps a reserve for interactive traffic and pauses on 429', () => {
    let t = 0;
    const th = new AdaptiveThrottle(0.2, () => t);
    th.observe({ limit: 10_000, remaining: 2_500, resetMs: 30_000 });
    expect(th.canStart(400, 'batch')).toEqual({ ok: true });          // 2 100 left ≥ 2 000 reserve
    expect(th.canStart(400, 'batch')).toEqual({ ok: false, waitMs: 30_000 });
    expect(th.canStart(400, 'interactive')).toEqual({ ok: true });    // may dip into the reserve
    th.onTooManyRequests(5_000);
    expect(th.canStart(1, 'interactive')).toEqual({ ok: false, waitMs: 5_000 });
    t = 30_000;
    expect(th.canStart(400, 'batch')).toEqual({ ok: true });          // window rolled over
  });
});

describe('fair queue', () => {
  const job = (tenantId: string, n: number, cost = 100, deadline = Number.POSITIVE_INFINITY): Job<string> => ({ tenantId, cost, deadline, payload: `${tenantId}-${n}` });

  it('serves a small tenant promptly while a large one has a backlog', () => {
    const q = new FairQueue<string>({ quantum: 100, maxPerTenant: 1_000 });
    for (let i = 0; i < 500; i++) q.enqueue(job('bulk', i));
    for (let i = 0; i < 3; i++) q.enqueue(job('small', i));
    const order = Array.from({ length: 6 }, () => q.dequeue()!.payload);
    expect(order).toEqual(['bulk-0', 'small-0', 'bulk-1', 'small-1', 'bulk-2', 'small-2']);
  });

  it('shares by cost, not by job count', () => {
    const q = new FairQueue<string>({ quantum: 1_000, maxPerTenant: 1_000 });
    for (let i = 0; i < 20; i++) q.enqueue(job('big-jobs', i, 1_000));
    for (let i = 0; i < 20; i++) q.enqueue(job('small-jobs', i, 100));
    const served = Array.from({ length: 22 }, () => q.dequeue()!);
    const cost = (t: string) => served.filter((j) => j.tenantId === t).reduce((s, j) => s + j.cost, 0);
    expect(cost('big-jobs')).toBe(2_000);
    expect(cost('small-jobs')).toBe(2_000);
  });

  it('honours weights', () => {
    const q = new FairQueue<string>({ quantum: 100, maxPerTenant: 1_000, weight: (t) => (t === 'enterprise' ? 3 : 1) });
    for (let i = 0; i < 50; i++) { q.enqueue(job('enterprise', i)); q.enqueue(job('starter', i)); }
    const first8 = Array.from({ length: 8 }, () => q.dequeue()!.tenantId);
    expect(first8.filter((t) => t === 'enterprise')).toHaveLength(6);
  });

  it('applies backpressure per tenant and drops expired work', () => {
    let t = 0;
    const q = new FairQueue<string>({ quantum: 100, maxPerTenant: 2 }, () => t);
    expect(q.enqueue(job('a', 0, 100, 10))).toEqual({ ok: true });
    expect(q.enqueue(job('a', 1, 100, 1_000))).toEqual({ ok: true });
    expect(q.enqueue(job('a', 2))).toEqual({ ok: false, reason: 'queue_full' });
    expect(q.enqueue(job('b', 0))).toEqual({ ok: true }); // other tenants unaffected
    t = 50;
    const expired: string[] = [];
    expect(q.dequeue((j) => expired.push(j.payload))!.payload).toBe('a-1');
    expect(expired).toEqual(['a-0']);
  });
});
