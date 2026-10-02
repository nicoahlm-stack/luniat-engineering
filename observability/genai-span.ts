// #region span
/** What the gateway knows about one model call. */
export interface CallRecord {
  operation: 'chat' | 'embeddings' | 'execute_tool';
  provider: string;
  requestModel: string;
  responseModel?: string;
  maxTokens?: number;
  usage?: { input: number; output: number; cacheRead?: number };
  finishReasons?: string[];
  error?: string;
  /** Our own context, kept in an app.* namespace. */
  tenantId: string;
  promptId: string;
  promptVersion: number;
  attempts: number;
  costUsd?: number;
  ttftMs?: number;
}

type Attr = string | number | boolean | string[];

/**
 * Maps a call to span attributes. Standard names follow the OpenTelemetry
 * semantic conventions for generative AI, so tracing back ends understand
 * them; everything specific to us lives under app.*. Prompt and completion
 * text are deliberately absent: content capture is opt-in, sampled and
 * redacted, and never part of the default span.
 */
export function genAiAttributes(c: CallRecord): Record<string, Attr> {
  const a: Record<string, Attr> = {
    'gen_ai.operation.name': c.operation,
    'gen_ai.provider.name': c.provider,
    'gen_ai.request.model': c.requestModel,
    'app.tenant_id': c.tenantId,
    'app.prompt.id': c.promptId,
    'app.prompt.version': c.promptVersion,
    'app.attempts': c.attempts,
  };
  if (c.responseModel) a['gen_ai.response.model'] = c.responseModel;
  if (c.maxTokens !== undefined) a['gen_ai.request.max_tokens'] = c.maxTokens;
  if (c.usage) {
    a['gen_ai.usage.input_tokens'] = c.usage.input;
    a['gen_ai.usage.output_tokens'] = c.usage.output;
    if (c.usage.cacheRead !== undefined) a['app.usage.cache_read_tokens'] = c.usage.cacheRead;
  }
  if (c.finishReasons?.length) a['gen_ai.response.finish_reasons'] = c.finishReasons;
  if (c.error) a['error.type'] = c.error;
  if (c.costUsd !== undefined) a['app.cost_usd'] = Number(c.costUsd.toFixed(6));
  if (c.ttftMs !== undefined) a['app.ttft_ms'] = c.ttftMs;
  return a;
}

/** Span name convention: "{operation} {model}". Low cardinality, readable in a trace view. */
export const spanName = (c: CallRecord) => `${c.operation} ${c.requestModel}`;
// #endregion span
