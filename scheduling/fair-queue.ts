export interface Job<T = unknown> {
  tenantId: string;
  /** Estimated cost in tokens; fairness is measured in cost, not in job count. */
  cost: number;
  /** Absolute time after which the result is useless. */
  deadline: number;
  payload: T;
}

export type Enqueue = { ok: true } | { ok: false; reason: 'queue_full' };

// #region drr
/**
 * Deficit round robin across tenants. Each tenant with work gets a quantum of
 * cost per round (scaled by its weight) and may dequeue jobs while its deficit
 * covers them. A tenant with ten thousand queued jobs gets the same share per
 * round as a tenant with one, so small tenants are never stuck behind a large
 * import. Expired jobs are dropped at dequeue instead of wasting quota.
 */
export class FairQueue<T> {
  private readonly queues = new Map<string, Job<T>[]>();
  private readonly deficit = new Map<string, number>();
  private readonly active: string[] = [];
  private cursor = 0;
  private granted = false;

  constructor(
    private readonly o: { quantum: number; maxPerTenant: number; weight?: (tenantId: string) => number },
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(job: Job<T>): Enqueue {
    let q = this.queues.get(job.tenantId);
    if (!q) { q = []; this.queues.set(job.tenantId, q); }
    if (q.length >= this.o.maxPerTenant) return { ok: false, reason: 'queue_full' }; // backpressure per tenant
    q.push(job);
    if (!this.active.includes(job.tenantId)) { this.active.push(job.tenantId); this.deficit.set(job.tenantId, 0); }
    return { ok: true };
  }

  /** Next job to run, or undefined if nothing is queued. Calls onExpired for dropped jobs. */
  dequeue(onExpired: (job: Job<T>) => void = () => {}): Job<T> | undefined {
    while (this.active.length) {
      if (this.cursor >= this.active.length) this.cursor = 0;
      const tenant = this.active[this.cursor]!;
      const q = this.queues.get(tenant)!;
      while (q.length && q[0]!.deadline <= this.now()) onExpired(q.shift()!);
      if (!q.length) { this.remove(tenant); continue; }
      // Each visit to a tenant tops up its deficit once, then it may spend it.
      if (!this.granted) {
        this.deficit.set(tenant, this.deficit.get(tenant)! + this.o.quantum * (this.o.weight?.(tenant) ?? 1));
        this.granted = true;
      }
      const head = q[0]!;
      if (head.cost <= this.deficit.get(tenant)!) {
        this.deficit.set(tenant, this.deficit.get(tenant)! - head.cost);
        q.shift();
        if (!q.length) this.remove(tenant);
        return head;
      }
      this.cursor++; // not enough deficit: move on, keep what was earned
      this.granted = false;
    }
    return undefined;
  }

  size(tenantId?: string): number {
    if (tenantId) return this.queues.get(tenantId)?.length ?? 0;
    let n = 0; for (const q of this.queues.values()) n += q.length; return n;
  }

  private remove(tenant: string): void {
    const i = this.active.indexOf(tenant);
    this.active.splice(i, 1);
    this.deficit.delete(tenant);
    if (i < this.cursor) this.cursor--;
    this.granted = false;
  }
}
// #endregion drr
