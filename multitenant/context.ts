import { AsyncLocalStorage } from 'node:async_hooks';

// #region context
export interface Principal {
  userId: string;
  tenantId: string;
}

const storage = new AsyncLocalStorage<Principal>();

/**
 * The tenant is established once, at the edge, from a verified credential,
 * and is then available to every function in the request without being
 * passed through (or overridden by) request parameters.
 */
export async function runAuthenticated<T>(
  token: string | undefined,
  verify: (token: string) => Promise<Principal | null>,
  fn: () => Promise<T>,
): Promise<T> {
  const principal = token ? await verify(token) : null;
  if (!principal) throw Object.assign(new Error('unauthenticated'), { status: 401 });
  return storage.run(Object.freeze({ ...principal }), fn);
}

/** Throws instead of returning undefined: code that needs a tenant must never run without one. */
export function currentTenant(): string {
  const p = storage.getStore();
  if (!p) throw new Error('no tenant in context');
  return p.tenantId;
}
// #endregion context
