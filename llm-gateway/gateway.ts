import { CircuitBreaker, type BreakerOptions } from './circuit-breaker.ts';
import { redact } from './redact.ts';
import { withRetry, type RetryPolicy } from './retry.ts';
import { TenantLimiter, type BucketOptions } from './token-bucket.ts';
import {
  PermanentError, RejectedError, RetryableError,
  type Clock, type ModelRequest, type ModelResponse, type Provider, type Usage,
} from './types.ts';

export interface Route {
  /** Providers in order of preference. Later entries are fallbacks. */
  providers: Provider[];
  /** USD per million tokens, used for cost accounting. */
  price: { input: number; output: number };
}

export interface GatewayEvent {
  tenantId: string;
  model: string;
  promptId: string;
  promptVersion: number;
  promptHash: string;
  provider: string | null;
  outcome: 'ok' | 'rejected' | 'error';
  error?: string;
  attempts: number;
  latencyMs: number;
  usage?: Usage;
  costUsd?: number;
  /** Redacted, truncated sample for debugging. Never the full text. */
  sample?: string;
}

export interface GatewayOptions {
  routes: Record<string, Route>;
  retry: RetryPolicy;
  breaker: BreakerOptions;
  limits: (tenantId: string) => BucketOptions;
  /** Rough input-token estimate before the call; real usage is reconciled after. */
  estimateInputTokens: (text: string) => number;
  onEvent: (e: GatewayEvent) => void;
  clock: Clock;
  random?: () => number;
}

// #region gateway
export class Gateway {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly limiter: TenantLimiter;

  constructor(private readonly o: GatewayOptions) {
    this.limiter = new TenantLimiter(o.limits, o.clock);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const started = this.o.clock.now();
    const deadline = started + req.timeoutMs;
    const base = {
      tenantId: req.tenantId, model: req.model,
      promptId: req.prompt.id, promptVersion: req.prompt.version, promptHash: req.prompt.hash,
    };
    let attempts = 0;
    let provider: string | null = null;

    const route = this.o.routes[req.model];
    if (!route) throw this.reject(base, started, new RejectedError(`unknown model ${req.model}`, 'invalid_input'));

    // 1. Admission: reserve the worst case for this tenant before any network call.
    const estimate = this.o.estimateInputTokens(req.prompt.system + req.prompt.user) + req.maxOutputTokens;
    const bucket = this.limiter.bucket(req.tenantId);
    if (!bucket.tryTake(estimate)) {
      const wait = bucket.waitTimeMs(estimate);
      throw this.reject(base, started, new RejectedError(`tenant over budget, retry in ${wait} ms`, 'rate_limited'));
    }

    const signal = AbortSignal.timeout(req.timeoutMs);
    try {
      // 2. Try providers in order; a provider with an open circuit is skipped.
      for (const p of route.providers) {
        const breaker = this.breaker(p.name);
        if (!breaker.tryAcquire()) continue;
        provider = p.name;
        try {
          const res = await withRetry(
            () => { attempts++; return p.complete(req, signal); },
            this.o.retry, this.o.clock, deadline, signal, this.o.random,
          );
          breaker.onSuccess();
          // 3. Reconcile: refund what we reserved but did not use.
          const used = res.usage.inputTokens + res.usage.outputTokens;
          if (used < estimate) bucket.refund(estimate - used);
          const costUsd = (res.usage.inputTokens * route.price.input + res.usage.outputTokens * route.price.output) / 1e6;
          this.o.onEvent({
            ...base, provider, outcome: 'ok', attempts, latencyMs: this.o.clock.now() - started,
            usage: res.usage, costUsd, sample: redact(res.text).slice(0, 200),
          });
          return { ...res, provider: p.name };
        } catch (err) {
          // Permanent errors are the caller's problem, not the provider's health.
          if (err instanceof PermanentError) throw err;
          breaker.onFailure();
          if (signal.aborted) throw err;
          // Retryable and exhausted on this provider: fall through to the next one.
        }
      }
      throw new RejectedError('no provider available (all circuits open or failing)', 'circuit_open');
    } catch (err) {
      bucket.refund(estimate); // nothing was served
      const e = err instanceof Error ? err : new Error(String(err));
      this.o.onEvent({
        ...base, provider, outcome: e instanceof RejectedError ? 'rejected' : 'error',
        error: `${e.name}: ${redact(e.message)}`, attempts, latencyMs: this.o.clock.now() - started,
      });
      throw e;
    }
  }

  private breaker(name: string): CircuitBreaker {
    let b = this.breakers.get(name);
    if (!b) { b = new CircuitBreaker(this.o.breaker, this.o.clock); this.breakers.set(name, b); }
    return b;
  }

  private reject(base: Omit<GatewayEvent, 'provider' | 'outcome' | 'attempts' | 'latencyMs'>, started: number, e: RejectedError): RejectedError {
    this.o.onEvent({ ...base, provider: null, outcome: 'rejected', error: `${e.name}: ${e.message}`, attempts: 0, latencyMs: this.o.clock.now() - started });
    return e;
  }
}
// #endregion gateway

export { PermanentError, RejectedError, RetryableError };
