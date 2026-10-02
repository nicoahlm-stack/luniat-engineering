// #region policy
export type Risk = 'read' | 'write' | 'external' | 'irreversible';

export interface ToolPolicy {
  name: string;
  risk: Risk;
}

export interface TurnState {
  /** Set as soon as anything not written by the user or by us enters the context. */
  tainted: boolean;
  /** Roles of the human in the loop for this session, if any. */
  approver: boolean;
}

export type Decision = { allow: true } | { allow: false; reason: string } | { allow: 'ask'; reason: string };

/**
 * Decides per tool call, outside the model. The rule that matters most:
 * once untrusted content (a web page, an email, a retrieved document from a
 * shared source, a tool result) is in the context, the model's choices may
 * be someone else's. From then on, anything beyond reading needs a human,
 * and irreversible actions are never automatic.
 */
export function decide(tool: ToolPolicy, state: TurnState): Decision {
  if (tool.risk === 'read') return { allow: true };
  if (tool.risk === 'irreversible') {
    return state.approver ? { allow: 'ask', reason: `${tool.name} cannot be undone` } : { allow: false, reason: `${tool.name} requires an approver` };
  }
  if (state.tainted) {
    return state.approver
      ? { allow: 'ask', reason: `${tool.name} after untrusted content` }
      : { allow: false, reason: `${tool.name} is blocked after untrusted content` };
  }
  return { allow: true };
}

/** Taint is sticky for the rest of the turn: it is never cleared by the model. */
export function afterToolResult(state: TurnState, source: 'internal' | 'external'): TurnState {
  return source === 'external' ? { ...state, tainted: true } : state;
}
// #endregion policy
