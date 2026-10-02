import { afterToolResult, decide, type Risk, type TurnState } from '../security/policy.ts';
import type { ToolCall, ToolRegistry, ToolResult } from '../structured/tools.ts';

// #region state
/** Everything needed to continue a run, as plain JSON. Persisted after every step. */
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; call?: ToolCall }
  | { role: 'tool'; callId: string; result: ToolResult };

export type AgentState =
  | { status: 'running'; step: number; errors: number; turn: TurnState; messages: Message[] }
  | { status: 'awaiting_approval'; step: number; errors: number; turn: TurnState; messages: Message[]; call: ToolCall; reason: string }
  | { status: 'done'; step: number; answer: string; messages: Message[] }
  | { status: 'failed'; step: number; reason: string; messages: Message[] };
// #endregion state

/** The model's next move: a final answer or one tool call. */
export type Decision = { type: 'final'; text: string } | { type: 'tool'; call: ToolCall; note?: string };

export interface AgentDeps {
  model: (messages: Message[]) => Promise<Decision>;
  tools: ToolRegistry;
  /** Risk and origin per tool; unknown tools are treated as irreversible. */
  meta: (tool: string) => { risk: Risk; returns: 'internal' | 'external' } | undefined;
  tenantId: string;
  now: () => number;
  save: (state: AgentState) => Promise<void>;
}

export interface Limits {
  maxSteps: number;
  deadline: number;
  maxConsecutiveErrors: number;
}

export function start(task: string, approver: boolean): AgentState {
  return { status: 'running', step: 0, errors: 0, turn: { tainted: false, approver }, messages: [{ role: 'user', content: task }] };
}

// #region run
/**
 * Runs until the agent finishes, fails, or needs a human. Every limit is
 * enforced by this loop, not requested from the model: a step budget, a
 * wall-clock deadline and a cap on consecutive tool errors. The state is
 * saved after every step, so a crash or a deploy resumes where it stopped,
 * and tool idempotency keys make the resumed step safe to repeat.
 */
export async function run(state: AgentState, d: AgentDeps, limits: Limits): Promise<AgentState> {
  let s = state;
  while (s.status === 'running') {
    if (s.step >= limits.maxSteps) s = fail(s, 'step budget exhausted');
    else if (d.now() >= limits.deadline) s = fail(s, 'deadline passed');
    else if (s.errors >= limits.maxConsecutiveErrors) s = fail(s, 'too many consecutive tool errors');
    else s = await step(s, d);
    await d.save(s);
  }
  return s;
}

async function step(s: Extract<AgentState, { status: 'running' }>, d: AgentDeps): Promise<AgentState> {
  const decision = await d.model(s.messages);
  if (decision.type === 'final') {
    return { status: 'done', step: s.step + 1, answer: decision.text, messages: [...s.messages, { role: 'assistant', content: decision.text }] };
  }
  const messages: Message[] = [...s.messages, { role: 'assistant', content: decision.note ?? '', call: decision.call }];
  const meta = d.meta(decision.call.name) ?? { risk: 'irreversible' as const, returns: 'external' as const };
  const verdict = decide({ name: decision.call.name, risk: meta.risk }, s.turn);
  if (verdict.allow === 'ask') {
    return { status: 'awaiting_approval', step: s.step + 1, errors: s.errors, turn: s.turn, messages, call: decision.call, reason: verdict.reason };
  }
  if (verdict.allow === false) {
    return toolDone({ ...s, step: s.step + 1, messages }, decision.call, { ok: false, error: 'not_permitted', detail: verdict.reason }, meta.returns);
  }
  return execute({ ...s, step: s.step + 1, messages }, decision.call, d, meta.returns);
}
// #endregion run

// #region approval
/**
 * Called when a human answers. Approval runs the exact call that was shown;
 * rejection is reported to the model as a tool result, so it can explain or
 * try something else. Answering twice is harmless: the state is no longer
 * awaiting approval, and the write is idempotent on its call id anyway.
 */
export async function resolveApproval(s: AgentState, approved: boolean, d: AgentDeps): Promise<AgentState> {
  if (s.status !== 'awaiting_approval') return s;
  const running = { status: 'running' as const, step: s.step, errors: s.errors, turn: s.turn, messages: s.messages };
  const returns = d.meta(s.call.name)?.returns ?? 'external';
  const next = approved
    ? await execute(running, s.call, d, returns)
    : toolDone(running, s.call, { ok: false, error: 'not_permitted', detail: 'rejected by a human reviewer' }, returns);
  await d.save(next);
  return next;
}
// #endregion approval

async function execute(s: Extract<AgentState, { status: 'running' }>, call: ToolCall, d: AgentDeps, returns: 'internal' | 'external'): Promise<AgentState> {
  const result = await d.tools.execute(call, { tenantId: d.tenantId, signal: new AbortController().signal, allowWrites: true });
  return toolDone(s, call, result, returns);
}

function toolDone(s: Extract<AgentState, { status: 'running' }>, call: ToolCall, result: ToolResult, returns: 'internal' | 'external'): AgentState {
  return {
    ...s,
    errors: result.ok ? 0 : s.errors + 1,
    turn: result.ok ? afterToolResult(s.turn, returns) : s.turn,
    messages: [...s.messages, { role: 'tool', callId: call.id, result }],
  };
}

function fail(s: AgentState, reason: string): AgentState {
  return { status: 'failed', step: s.step, reason, messages: s.messages };
}
