import { createHash } from 'node:crypto';

type Entry = { requestHash: string; state: 'running' | 'done'; result?: unknown; expiresAt: number };

export type Begin =
  | { kind: 'new' }
  | { kind: 'replay'; result: unknown }
  | { kind: 'in-progress' }
  | { kind: 'conflict' };

// #region idempotency
/**
 * At-most-once execution for side effects. The key is scoped to the tenant,
 * and the request body is hashed: the same key with a different body is a
 * client bug and must fail loudly instead of returning someone else's result.
 * In production this lives in Redis or a database with a unique constraint;
 * the protocol is the same.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  static hash(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  begin(tenantId: string, key: string, body: unknown): Begin {
    const id = `${tenantId}:${key}`;
    const requestHash = IdempotencyStore.hash(body);
    const e = this.entries.get(id);
    if (e && e.expiresAt > this.now()) {
      if (e.requestHash !== requestHash) return { kind: 'conflict' };
      return e.state === 'done' ? { kind: 'replay', result: e.result } : { kind: 'in-progress' };
    }
    this.entries.set(id, { requestHash, state: 'running', expiresAt: this.now() + this.ttlMs });
    return { kind: 'new' };
  }

  complete(tenantId: string, key: string, result: unknown): void {
    const e = this.entries.get(`${tenantId}:${key}`);
    if (e) Object.assign(e, { state: 'done', result });
  }

  /** On failure, release the key so a retry can run the operation again. */
  abandon(tenantId: string, key: string): void {
    this.entries.delete(`${tenantId}:${key}`);
  }
}
// #endregion idempotency
