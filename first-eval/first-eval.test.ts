import { describe, expect, it } from 'vitest';
import { compare, loadCases, runCases } from './first-eval.ts';

const cases = loadCases(new URL('./cases.jsonl', import.meta.url).pathname);

// Two versions of a pretend support assistant: the old prompt and a "small improvement".
const v1 = async (q: string) => ({
  'Hur länge har jag på mig att returnera en vara?': 'Du kan returnera varor inom 30 dagar från leverans.',
  'Min lampa kom trasig, vad gör jag?': 'Skicka en bild på skadan så skickar vi en ny utan kostnad.',
  'När kommer mitt paket?': 'Vi skickar inom två arbetsdagar.',
  'Har ni öppet på midsommarafton?': 'Det vet inte jag, men kundtjänst kan svara.',
} as Record<string, string>)[q]!;
const v2 = async (q: string) => q.startsWith('Har ni öppet')
  ? 'Ja, vi har öppet till 15 på midsommarafton!' // sounds helpful, is invented
  : v1(q);

describe('first eval', () => {
  it('loads the cases from a plain JSONL file', () => {
    expect(cases.map((c) => c.id)).toEqual(['retur-30-dagar', 'retur-skadad', 'leverans-tid', 'ingen-gissning']);
  });

  it('passes the current version and explains failures in plain words', async () => {
    const before = await runCases(cases, v1);
    expect(before.every((r) => r.pass)).toBe(true);
    const after = await runCases(cases, v2);
    expect(after.find((r) => r.id === 'ingen-gissning')!.why).toEqual(['saknar "vet inte"', 'innehåller "öppet till"']);
  });

  it('shows exactly what a change broke', async () => {
    const diff = compare(await runCases(cases, v1), await runCases(cases, v2));
    expect(diff).toEqual({ passRate: 0.75, newlyFailing: ['ingen-gissning'], newlyPassing: [] });
  });
});
