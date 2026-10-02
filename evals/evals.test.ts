import { describe, expect, it } from 'vitest';
import { parseJsonl, type EvalCase } from './dataset.ts';
import { agreement, llmJudge, parseVerdict } from './judge.ts';
import { gate, runSuite, type CaseResult } from './runner.ts';
import { exactLabel, forbids, jsonFields, scoreAll } from './scorers.ts';
import { mcnemarWorse, wilson } from './stats.ts';

const c = (id: string, expected: unknown, tags: string[] = []): EvalCase => ({ id, input: `input ${id}`, expected, tags });

describe('dataset', () => {
  it('loads JSONL strictly', () => {
    const cases = parseJsonl('{"id":"a","input":"x","tags":["billing"]}\n\n{"id":"b","input":"y"}\n');
    expect(cases.map((x) => [x.id, x.tags])).toEqual([['a', ['billing']], ['b', []]]);
    expect(() => parseJsonl('{"id":"a","input":"x"}\n{"id":"a","input":"y"}')).toThrow(/duplicate id a/);
    expect(() => parseJsonl('{"id":"a"}')).toThrow(/missing input/);
    expect(() => parseJsonl('{"id":"a","input":"x"')).toThrow(/line 1: invalid JSON/);
  });
});

describe('scorers', () => {
  it('normalises labels', () => {
    expect(exactLabel('  Billing\n', c('1', 'billing'))).toMatchObject({ pass: true });
  });

  it('names the fields that are wrong', () => {
    const expected = { invoiceNumber: 'F-1042', total: 1250, currency: 'SEK' };
    expect(jsonFields('{"invoiceNumber":"F-1042","total":1250,"currency":"SEK","vat":250}', c('1', expected)).pass).toBe(true);
    expect(jsonFields('{"invoiceNumber":"F-1042","total":125}', c('1', expected))).toEqual({ pass: false, reason: 'wrong or missing: total, currency' });
    expect(jsonFields('Sure! Here is the JSON: {}', c('1', expected))).toEqual({ pass: false, reason: 'output is not valid JSON' });
  });

  it('requires every scorer to pass', async () => {
    const r = await scoreAll('Your refund of 500 kr is on its way', c('1', 'x'), [forbids(/\d+\s?kr/i, 'a price')]);
    expect(r).toEqual({ pass: false, reason: 'contains a price' });
  });
});

describe('judge', () => {
  it('treats anything but a well-formed verdict as a failure', () => {
    expect(parseVerdict('{"reason":"polite and correct","verdict":"pass"}')).toEqual({ pass: true, reason: 'judge: polite and correct' });
    expect(parseVerdict('```json\n{"reason":"rude","verdict":"fail"}\n```').pass).toBe(false);
    expect(parseVerdict('PASS').reason).toBe('judge returned an unparseable verdict');
    expect(parseVerdict('{"verdict":"maybe","reason":"?"}').pass).toBe(false);
  });

  it('sends the rubric, input and output to the judge model', async () => {
    let seen = '';
    const judge = llmJudge(async (_system, user) => { seen = user; return '{"reason":"ok","verdict":"pass"}'; }, 'Must be polite.');
    await judge('Hello!', c('1', undefined));
    expect(seen).toContain('Must be polite.');
    expect(seen).toContain('input 1');
    expect(seen).toContain('Hello!');
  });

  it('reports chance-corrected agreement with human labels', () => {
    const human = [true, true, true, true, true, true, true, true, false, false];
    const judge = [true, true, true, true, true, true, true, false, true, false];
    const a = agreement(human, judge);
    expect(a.accuracy).toBeCloseTo(0.8);
    expect(a.kappa).toBeCloseTo(0.375); // 80 % raw agreement, but only fair beyond chance
  });
});

describe('statistics', () => {
  it('computes the Wilson interval', () => {
    const { low, high } = wilson(97, 100);
    expect(low).toBeCloseTo(0.9155, 4);
    expect(high).toBeCloseTo(0.9897, 4);
  });

  it('computes the exact one-sided McNemar p-value', () => {
    expect(mcnemarWorse(8, 1)).toBeCloseTo(10 / 512, 6);
    expect(mcnemarWorse(0, 0)).toBe(1);
    expect(mcnemarWorse(3, 3)).toBeCloseTo(0.65625, 6);
  });
});

describe('runner', () => {
  it('bounds concurrency and records crashes as failures', async () => {
    let active = 0, peak = 0;
    const system = async (input: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (input === 'input 3') throw new Error('timeout');
      return 'billing';
    };
    const cases = Array.from({ length: 10 }, (_, i) => c(String(i), 'billing'));
    const results = await runSuite(cases, system, [exactLabel], 3);
    expect(peak).toBe(3);
    expect(results.filter((r) => !r.pass).map((r) => [r.id, r.reason])).toEqual([['3', 'error: timeout']]);
  });
});

describe('release gate', () => {
  const result = (id: string, pass: boolean, tags: string[] = []): CaseResult => ({ id, pass, tags, reason: '', output: '' });
  const policy = { criticalTag: 'critical', alpha: 0.05, maxDrop: 0.02 };
  const suite = (n: number, failing: Set<number>, critical = new Set<number>()) =>
    Array.from({ length: n }, (_, i) => result(String(i), !failing.has(i), critical.has(i) ? ['critical'] : []));

  it('passes when the candidate trades a few cases evenly', () => {
    const d = gate(suite(200, new Set([1, 2, 3])), suite(200, new Set([4, 5, 6])), policy);
    expect(d.pass).toBe(true);
    expect(d.regressions).toEqual(['4', '5', '6']);
    expect(d.fixes).toEqual(['1', '2', '3']);
  });

  it('blocks a single critical regression even when the overall rate improves', () => {
    const d = gate(suite(200, new Set([1, 2, 3]), new Set([9])), suite(200, new Set([9]), new Set([9])), policy);
    expect(d.candidate.rate).toBeGreaterThan(d.baseline.rate);
    expect(d.pass).toBe(false);
    expect(d.reasons).toEqual(['critical cases regressed: 9']);
  });

  it('blocks a significant regression', () => {
    const d = gate(suite(200, new Set()), suite(200, new Set([1, 2, 3, 4, 5, 6, 7, 8])), { ...policy, maxDrop: 1 });
    expect(d.pValue).toBeCloseTo(1 / 256, 6);
    expect(d.reasons).toEqual(['significantly worse (McNemar p = 0.0039)']);
  });
});
