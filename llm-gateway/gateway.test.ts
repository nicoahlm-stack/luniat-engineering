import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.ts';
import { Gateway, type GatewayEvent } from './gateway.ts';
import { PromptRegistry } from './prompts.ts';
import { redact } from './redact.ts';
import { backoffDelay, withRetry } from './retry.ts';
import { TokenBucket } from './token-bucket.ts';
import { PermanentError, RejectedError, RetryableError, type Clock, type ModelRequest, type Provider } from './types.ts';

/** Deterministic clock: sleep advances time instantly and records the waits. */
function fakeClock(start = 0): Clock & { waits: number[]; advance(ms: number): void } {
  let t = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
  };
}

/** Provider that plays back a script of outcomes, one per call. */
function scripted(name: string, script: Array<'ok' | Error>): Provider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async complete() {
      const step = script[Math.min(p.calls, script.length - 1)]!;
      p.calls++;
      if (step instanceof Error) throw step;
      return { text: `answer from ${name}`, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return p;
}

const registry = new PromptRegistry();
registry.register({ id: 'summarise', version: 3, system: 'You summarise support tickets.', user: 'Ticket:\n{{ticket}}' });

function request(tenantId = 'tenant-a', maxOutputTokens = 500): ModelRequest {
  return {
    tenantId, model: 'default', maxOutputTokens, timeoutMs: 60_000,
    prompt: registry.render('summarise', 3, { ticket: 'Printer on floor 2 is offline.' }),
  };
}

function gateway(providers: Provider[], clock = fakeClock(), events: GatewayEvent[] = []) {
  return new Gateway({
    routes: { default: { providers, price: { input: 3, output: 15 } } },
    retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
    breaker: { failureThreshold: 3, windowMs: 30_000, cooldownMs: 10_000 },
    limits: () => ({ capacity: 10_000, refillPerSecond: 100 }),
    estimateInputTokens: (s) => Math.ceil(s.length / 4),
    onEvent: (e) => events.push(e),
    clock,
    random: () => 0.5,
  });
}

describe('retry', () => {
  it('uses full jitter bounded by the cap', () => {
    const p = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(backoffDelay(0, p, () => 0.999)).toBe(99);
    expect(backoffDelay(3, p, () => 0.5)).toBe(400);
    expect(backoffDelay(10, p, () => 0.999)).toBe(999);
  });

  it('honours Retry-After over its own backoff', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await withRetry(async () => {
      if (n++ === 0) throw new RetryableError('429', 1_500);
      return 'ok';
    }, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }, clock, 60_000, new AbortController().signal);
    expect(result).toBe('ok');
    expect(clock.waits).toEqual([1_500]);
  });

  it('does not wait past the deadline', async () => {
    const clock = fakeClock();
    const fail = () => Promise.reject(new RetryableError('503', 5_000));
    await expect(withRetry(fail, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 }, clock, 2_000, new AbortController().signal))
      .rejects.toThrow('503');
    expect(clock.waits).toEqual([]);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold, lets one probe through after the cooldown', () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ failureThreshold: 2, windowMs: 1_000, cooldownMs: 5_000 }, clock);
    b.onFailure(); b.onFailure();
    expect(b.state()).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    clock.advance(5_000);
    expect(b.tryAcquire()).toBe(true);  // the probe
    expect(b.tryAcquire()).toBe(false); // everyone else still fails fast
    b.onSuccess();
    expect(b.state()).toBe('closed');
  });

  it('forgets failures outside the window', () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ failureThreshold: 2, windowMs: 1_000, cooldownMs: 5_000 }, clock);
    b.onFailure(); clock.advance(1_500); b.onFailure();
    expect(b.state()).toBe('closed');
  });
});

describe('token bucket', () => {
  it('refills over time and reports the wait', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 1_000, refillPerSecond: 100 }, clock);
    expect(b.tryTake(900)).toBe(true);
    expect(b.tryTake(500)).toBe(false);
    expect(b.waitTimeMs(500)).toBe(4_000);
    clock.advance(4_000);
    expect(b.tryTake(500)).toBe(true);
  });
});

describe('gateway', () => {
  it('retries a 429 and reports cost and attempts', async () => {
    const events: GatewayEvent[] = [];
    const clock = fakeClock();
    const primary = scripted('primary', [new RetryableError('429', 1_000), 'ok']);
    const res = await gateway([primary], clock, events).complete(request());
    expect(res.provider).toBe('primary');
    expect(clock.waits).toEqual([1_000]);
    expect(events[0]).toMatchObject({ outcome: 'ok', attempts: 2, promptId: 'summarise', promptVersion: 3 });
    expect(events[0]!.costUsd).toBeCloseTo((100 * 3 + 50 * 15) / 1e6);
  });

  it('never retries a permanent error and does not count it against the provider', async () => {
    const primary = scripted('primary', [new PermanentError('400 invalid request')]);
    const fallback = scripted('fallback', ['ok']);
    await expect(gateway([primary, fallback]).complete(request())).rejects.toBeInstanceOf(PermanentError);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  // #region test-fallback
  it('falls back when the primary keeps failing, then skips it while its circuit is open', async () => {
    const primary = scripted('primary', [new RetryableError('503')]);
    const fallback = scripted('fallback', ['ok']);
    const gw = gateway([primary, fallback]);
    for (let i = 0; i < 3; i++) expect((await gw.complete(request())).provider).toBe('fallback');
    expect(primary.calls).toBe(9); // 3 requests × 3 attempts, then the circuit opens
    await gw.complete(request());
    expect(primary.calls).toBe(9); // open circuit: not called at all
  });
  // #endregion test-fallback

  it('isolates tenants: a tenant with calls in flight cannot take another tenant\'s budget', async () => {
    const events: GatewayEvent[] = [];
    const pending: Array<() => void> = [];
    const slow: Provider = {
      name: 'primary',
      complete: () => new Promise((resolve) => {
        pending.push(() => resolve({ text: 'done', usage: { inputTokens: 100, outputTokens: 50 } }));
      }),
    };
    const gw = gateway([slow], fakeClock(), events);
    // Tenant A reserves ~9 000 of its 10 000 tokens and the call is still running.
    const inFlight = gw.complete(request('tenant-a', 9_000));
    await expect(gw.complete(request('tenant-a', 9_000))).rejects.toMatchObject({ reason: 'rate_limited' });
    // Tenant B has its own bucket and is unaffected.
    const other = gw.complete(request('tenant-b', 9_000));
    pending.forEach((release) => release());
    await Promise.all([inFlight, other]);
    expect(events.map((e) => [e.tenantId, e.outcome])).toEqual([['tenant-a', 'rejected'], ['tenant-a', 'ok'], ['tenant-b', 'ok']]);
  });

  it('refunds the unused part of the reservation once real usage is known', async () => {
    const gw = gateway([scripted('primary', ['ok'])]);
    // Each call reserves ~9 000 tokens but uses 150; without refunds the second would be rejected.
    await gw.complete(request('tenant-a', 9_000));
    await expect(gw.complete(request('tenant-a', 9_000))).resolves.toMatchObject({ provider: 'primary' });
  });

  it('rejects unknown models before doing anything', async () => {
    const r = { ...request(), model: 'gpt-unknown' };
    await expect(gateway([scripted('primary', ['ok'])]).complete(r)).rejects.toBeInstanceOf(RejectedError);
  });
});

describe('prompt registry', () => {
  it('pins content to a version', () => {
    const r = new PromptRegistry();
    r.register({ id: 'p', version: 1, system: 's', user: 'u {{x}}' });
    expect(() => r.register({ id: 'p', version: 1, system: 's', user: 'changed {{x}}' })).toThrow(/bump the version/);
  });

  it('refuses missing and unexpected variables', () => {
    expect(() => registry.render('summarise', 3, {})).toThrow(/missing \[ticket\]/);
    expect(() => registry.render('summarise', 3, { ticket: 't', tenant: 'x' })).toThrow(/unexpected \[tenant\]/);
  });
});

describe('redaction', () => {
  it('removes personal data and secrets from telemetry', () => {
    const out = redact('Mail anna.svensson@example.se, call +46 70 123 45 67, pnr 19850101-1234, key sk-live_abcdefghijklmnop1234, card 4111 1111 1111 1111');
    expect(out).toBe('Mail [email], call [phone], pnr [national-id], key [secret], card [card]');
  });
});
