import { validate, type Schema, type ValidationError } from './schema.ts';

export type Message = { role: 'user' | 'assistant'; content: string };
export type Complete = (system: string, messages: Message[]) => Promise<string>;

export class StructuredOutputError extends Error {
  override readonly name = 'StructuredOutputError';
  constructor(message: string, readonly errors: ValidationError[], readonly attempts: number) {
    super(message);
  }
}

// #region extract
/**
 * Models wrap JSON in prose or code fences more often than anyone would like.
 * Take the outermost object; anything else is a parse failure, not a guess.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1]! : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new SyntaxError('no JSON object in output');
  return JSON.parse(text.slice(start, end + 1));
}
// #endregion extract

// #region generate
/**
 * Generate → parse → validate → repair. On failure the model sees its own
 * output and the exact list of errors, which fixes most problems in one
 * extra call. Business rules that a schema cannot express go in `check`.
 */
export async function generateStructured<T>(o: {
  complete: Complete;
  system: string;
  input: string;
  schema: Schema;
  check?: (value: T) => ValidationError[];
  maxAttempts?: number;
}): Promise<{ value: T; attempts: number }> {
  const max = o.maxAttempts ?? 2;
  const system = `${o.system}\n\nRespond with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(o.schema)}`;
  const messages: Message[] = [{ role: 'user', content: o.input }];
  let errors: ValidationError[] = [];

  for (let attempt = 1; attempt <= max; attempt++) {
    const raw = await o.complete(system, messages);
    let value: unknown;
    try {
      value = extractJson(raw);
      errors = validate(value, o.schema);
      if (!errors.length && o.check) errors = o.check(value as T);
    } catch (e) {
      errors = [{ path: '/', message: `invalid JSON: ${(e as Error).message}` }];
    }
    if (!errors.length) return { value: value as T, attempts: attempt };
    messages.push(
      { role: 'assistant', content: raw },
      { role: 'user', content: `Your output failed validation:\n${errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')}\nReturn the corrected JSON object only.` },
    );
  }
  throw new StructuredOutputError(`no valid output after ${max} attempts`, errors, max);
}
// #endregion generate
