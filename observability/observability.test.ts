import { describe, expect, it } from 'vitest';
import { genAiAttributes, spanName } from './genai-span.ts';
import { Histogram } from './histogram.ts';
import { keepTrace } from './sampling.ts';

describe('gen_ai span attributes', () => {
  const call = {
    operation: 'chat' as const, provider: 'example-provider', requestModel: 'default', responseModel: 'example-model-2026-09',
    maxTokens: 800, usage: { input: 2_100, output: 340, cacheRead: 1_800 }, finishReasons: ['stop'],
    tenantId: 't1', promptId: 'support-answer', promptVersion: 7, attempts: 1, costUsd: 0.0123456789, ttftMs: 420,
  };

  it('uses the standard names and keeps our own under app.*', () => {
    expect(genAiAttributes(call)).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'example-provider',
      'gen_ai.request.model': 'default',
      'gen_ai.response.model': 'example-model-2026-09',
      'gen_ai.request.max_tokens': 800,
      'gen_ai.usage.input_tokens': 2_100,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.response.finish_reasons': ['stop'],
      'app.usage.cache_read_tokens': 1_800,
      'app.tenant_id': 't1',
      'app.prompt.id': 'support-answer',
      'app.prompt.version': 7,
      'app.attempts': 1,
      'app.cost_usd': 0.012346,
      'app.ttft_ms': 420,
    });
    expect(spanName(call)).toBe('chat default');
  });

  it('never includes prompt or completion text', () => {
    const keys = Object.keys(genAiAttributes(call));
    expect(keys.some((k) => /prompt$|completion|content|messages/.test(k))).toBe(false);
  });
});

describe('tail sampling', () => {
  const base = { durationMs: 900, error: false, flagged: false, tenantId: 't1' };
  const o = { slowMs: 10_000, baseRate: 0.1 };

  it('keeps every error, flagged and slow trace', () => {
    expect(keepTrace({ ...base, traceId: 'a', error: true }, o).reason).toBe('error');
    expect(keepTrace({ ...base, traceId: 'b', flagged: true }, o).reason).toBe('flagged');
    expect(keepTrace({ ...base, traceId: 'c', durationMs: 12_000 }, o).reason).toBe('slow');
  });

  it('samples the rest deterministically, close to the configured rate', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `trace-${i}`);
    const kept = ids.filter((id) => keepTrace({ ...base, traceId: id }, o).keep).length;
    expect(kept / ids.length).toBeGreaterThan(0.09);
    expect(kept / ids.length).toBeLessThan(0.11);
    expect(keepTrace({ ...base, traceId: 'trace-42' }, o)).toEqual(keepTrace({ ...base, traceId: 'trace-42' }, o));
  });
});

describe('latency histogram', () => {
  it('estimates quantiles within the bucket width', () => {
    const h = new Histogram();
    for (let i = 0; i < 90; i++) h.record(600);   // typical answers
    for (let i = 0; i < 9; i++) h.record(4_000);  // long answers
    h.record(30_000);                             // one very long generation
    expect(h.quantile(0.5)).toBeGreaterThan(500);
    expect(h.quantile(0.5)).toBeLessThanOrEqual(750);
    expect(h.quantile(0.95)).toBeGreaterThan(2_500);
    expect(h.quantile(0.95)).toBeLessThanOrEqual(5_000);
    expect(h.quantile(0.999)).toBeGreaterThan(20_000);
    expect(h.sum / h.count).toBeCloseTo(1_200, 6); // the mean hides both tails
  });
});
