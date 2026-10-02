import { describe, expect, it } from 'vitest';
import { extractJson, generateStructured, StructuredOutputError, type Message } from './generate.ts';
import { IdempotencyStore } from './idempotency.ts';
import { validate, type Schema } from './schema.ts';
import { ToolRegistry, type Tool } from './tools.ts';

const invoice: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['invoiceNumber', 'currency', 'lines'],
  properties: {
    invoiceNumber: { type: 'string', pattern: '^[A-Z]-\\d+$' },
    currency: { type: 'string', enum: ['SEK', 'EUR'] },
    dueDate: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] },
    lines: {
      type: 'array', minItems: 1,
      items: { type: 'object', required: ['amount'], properties: { description: { type: 'string' }, amount: { type: 'number', minimum: 0 } } },
    },
  },
};

describe('schema validation', () => {
  it('accepts a valid object and reports every error with a path', () => {
    expect(validate({ invoiceNumber: 'F-1042', currency: 'SEK', dueDate: null, lines: [{ amount: 1250 }] }, invoice)).toEqual([]);
    expect(validate({ invoiceNumber: '1042', currency: 'USD', lines: [{ amount: -5 }, {}], vat: 1 }, invoice)).toEqual([
      { path: '/invoiceNumber', message: 'does not match ^[A-Z]-\\d+$' },
      { path: '/currency', message: 'must be one of SEK, EUR' },
      { path: '/lines/0/amount', message: 'must be >= 0' },
      { path: '/lines/1/amount', message: 'is required' },
      { path: '/vat', message: 'is not allowed' },
    ]);
  });
});

describe('structured generation', () => {
  it('extracts JSON from fences and prose', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('I could not find an invoice.')).toThrow(/no JSON object/);
  });

  it('repairs once with the exact errors, then succeeds', async () => {
    const seen: Message[][] = [];
    const outputs = ['{"invoiceNumber":"1042","currency":"SEK","lines":[{"amount":1250}]}', '{"invoiceNumber":"F-1042","currency":"SEK","lines":[{"amount":1250}]}'];
    const complete = async (_s: string, m: Message[]) => { seen.push([...m]); return outputs[seen.length - 1]!; };
    const r = await generateStructured({ complete, system: 'Extract the invoice.', input: 'Faktura F-1042 …', schema: invoice });
    expect(r.attempts).toBe(2);
    expect(seen[1]!.at(-1)!.content).toContain('/invoiceNumber: does not match');
  });

  it('applies business rules a schema cannot express, and gives up after the limit', async () => {
    const complete = async () => '{"invoiceNumber":"F-1","currency":"SEK","lines":[{"amount":100}],"dueDate":"2020-01-01"}';
    const check = (v: { dueDate?: string | null }) => (v.dueDate && v.dueDate < '2024-01-01' ? [{ path: '/dueDate', message: 'is before the invoice date' }] : []);
    await expect(generateStructured({ complete, system: 's', input: 'i', schema: invoice, check, maxAttempts: 2 }))
      .rejects.toMatchObject({ name: 'StructuredOutputError', attempts: 2, errors: [{ path: '/dueDate' }] });
    expect(StructuredOutputError).toBeDefined();
  });
});

describe('tool execution', () => {
  let sent = 0;
  const sendEmail: Tool<{ to: string; subject: string }, { messageId: string }> = {
    name: 'send_email', description: 'Send an email to a customer of this tenant.', effect: 'write',
    input: { type: 'object', additionalProperties: false, required: ['to', 'subject'], properties: { to: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+$' }, subject: { type: 'string', maxLength: 120 } } },
    run: async () => ({ messageId: `m-${++sent}` }),
  };
  const lookupOrder: Tool<{ orderId: string }, { status: string; tenant: string }> = {
    name: 'lookup_order', description: 'Look up an order by id.', effect: 'read',
    input: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
    run: async (args, ctx) => ({ status: 'shipped', tenant: ctx.tenantId }),
  };
  const registry = () => {
    const r = new ToolRegistry(new IdempotencyStore(60_000));
    r.register(sendEmail); r.register(lookupOrder);
    return r;
  };
  const ctx = (allowWrites: boolean) => ({ tenantId: 't1', signal: new AbortController().signal, allowWrites });

  it('runs a write at most once per call id, and replays the result', async () => {
    const r = registry();
    const call = { id: 'call_1', name: 'send_email', arguments: { to: 'anna@example.se', subject: 'Your refund' } };
    const first = await r.execute(call, ctx(true));
    const retry = await r.execute(call, ctx(true));
    expect(first).toEqual({ ok: true, content: { messageId: 'm-1' } });
    expect(retry).toEqual({ ok: true, content: { messageId: 'm-1' }, replayed: true });
    expect(sent).toBe(1);
    expect(await r.execute({ ...call, arguments: { to: 'other@example.se', subject: 'x' } }, ctx(true))).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('refuses writes where they are not allowed, even if the model calls them', async () => {
    const r = registry();
    expect(r.definitions(false).map((d) => d.name)).toEqual(['lookup_order']);
    expect(await r.execute({ id: 'c', name: 'send_email', arguments: { to: 'a@b.se', subject: 's' } }, ctx(false)))
      .toMatchObject({ ok: false, error: 'not_permitted' });
  });

  it('returns validation errors to the model instead of throwing', async () => {
    expect(await registry().execute({ id: 'c', name: 'send_email', arguments: { to: 'not-an-email', subject: 's' } }, ctx(true)))
      .toEqual({ ok: false, error: 'invalid_arguments', detail: '/to: does not match ^[^@\\s]+@[^@\\s]+$' });
    expect(await registry().execute({ id: 'c', name: 'drop_table', arguments: {} }, ctx(true))).toMatchObject({ error: 'unknown_tool' });
  });

  it('takes the tenant from the context, never from the arguments', async () => {
    const res = await registry().execute({ id: 'c', name: 'lookup_order', arguments: { orderId: 'o-1', tenantId: 't2' } }, ctx(false));
    expect(res).toEqual({ ok: true, content: { status: 'shipped', tenant: 't1' } });
  });
});
