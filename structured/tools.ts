import { IdempotencyStore } from './idempotency.ts';
import { validate, type Schema } from './schema.ts';

// #region tool
export interface Tool<A = unknown, R = unknown> {
  name: string;
  /** Read by the model. Treat it as part of the prompt: versioned and reviewed. */
  description: string;
  input: Schema;
  /** Writes change the world and get stricter handling than reads. */
  effect: 'read' | 'write';
  run(args: A, ctx: ToolContext): Promise<R>;
}

export interface ToolContext {
  /** From the authenticated session, never from the model's arguments. */
  tenantId: string;
  signal: AbortSignal;
}

/** What the model gets back. Errors are data the model can act on, not exceptions. */
export type ToolResult =
  | { ok: true; content: unknown; replayed?: boolean }
  | { ok: false; error: 'unknown_tool' | 'invalid_arguments' | 'not_permitted' | 'in_progress' | 'conflict' | 'failed'; detail: string };
// #endregion tool

export interface ToolCall {
  /** Provider-assigned id for the call; stable across retries of the same turn. */
  id: string;
  name: string;
  arguments: unknown;
}

// #region execute
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never, unknown>>();

  constructor(private readonly idempotency: IdempotencyStore, private readonly timeoutMs = 10_000) {}

  register<A, R>(tool: Tool<A, R>): void {
    this.tools.set(tool.name, tool as unknown as Tool<never, unknown>);
  }

  /** Tool definitions for the provider API, filtered by what this caller may use. */
  definitions(allowWrites: boolean) {
    return [...this.tools.values()]
      .filter((t) => allowWrites || t.effect === 'read')
      .map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));
  }

  async execute(call: ToolCall, ctx: ToolContext & { allowWrites: boolean }): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) return { ok: false, error: 'unknown_tool', detail: `no tool named ${call.name}` };
    // Enforced here, not only by hiding the definition: models can and do call tools they were not offered.
    if (tool.effect === 'write' && !ctx.allowWrites) return { ok: false, error: 'not_permitted', detail: `${call.name} is not allowed here` };

    const errors = validate(call.arguments, tool.input);
    if (errors.length) return { ok: false, error: 'invalid_arguments', detail: errors.map((e) => `${e.path}: ${e.message}`).join('; ') };

    // Writes run at most once per tool call id, even if the turn is retried.
    if (tool.effect === 'write') {
      const begin = this.idempotency.begin(ctx.tenantId, `${call.name}:${call.id}`, call.arguments);
      if (begin.kind === 'replay') return { ok: true, content: begin.result, replayed: true };
      if (begin.kind === 'in-progress') return { ok: false, error: 'in_progress', detail: 'this call is already running' };
      if (begin.kind === 'conflict') return { ok: false, error: 'conflict', detail: 'call id reused with different arguments' };
    }

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const content = await tool.run(call.arguments as never, { tenantId: ctx.tenantId, signal });
      if (tool.effect === 'write') this.idempotency.complete(ctx.tenantId, `${call.name}:${call.id}`, content);
      return { ok: true, content };
    } catch (e) {
      if (tool.effect === 'write') this.idempotency.abandon(ctx.tenantId, `${call.name}:${call.id}`);
      return { ok: false, error: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
// #endregion execute
