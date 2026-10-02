// #region types
/** One request to a model, as the rest of the system sees it. */
export interface ModelRequest {
  /** Tenant the request is made on behalf of. Never taken from user input. */
  tenantId: string;
  /** Logical model name, resolved to a provider by the gateway. */
  model: string;
  /** Rendered prompt, produced by the prompt registry. */
  prompt: RenderedPrompt;
  /** Upper bound on output tokens. Also used for rate limiting and cost. */
  maxOutputTokens: number;
  /** End-to-end deadline for this call, including retries. */
  timeoutMs: number;
}

export interface RenderedPrompt {
  id: string;
  version: number;
  /** sha256 of the template, so logs can prove which text was sent. */
  hash: string;
  system: string;
  user: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  usage: Usage;
  /** Which provider actually served the call (after fallback). */
  provider: string;
}

/** A provider adapter wraps one vendor SDK behind a common interface. */
export interface Provider {
  readonly name: string;
  complete(req: ModelRequest, signal: AbortSignal): Promise<Omit<ModelResponse, 'provider'>>;
}
// #endregion types

// #region errors
/** Safe to retry: 429, 5xx, timeouts, connection resets. */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Never retry: 4xx validation errors, auth errors, content policy refusals. */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/** Raised by the gateway itself before a provider is called. */
export class RejectedError extends Error {
  override readonly name = 'RejectedError';
  constructor(message: string, readonly reason: 'rate_limited' | 'circuit_open' | 'invalid_input') {
    super(message);
  }
}
// #endregion errors

/** Injected so tests can control time. Production uses Date.now and setTimeout. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    }),
};
