/** A transaction-capable client: PGlite in tests, a pooled connection in production. */
export interface Tx {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface TxDb {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #region with-tenant
/**
 * Every tenant-scoped query runs inside this function. The tenant id and the
 * role are set with transaction scope (set_config(..., true) and SET LOCAL),
 * so they vanish at commit or rollback and can never leak to the next request
 * that borrows the same pooled connection.
 */
export async function withTenant<T>(db: TxDb, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('invalid tenant id');
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    await tx.query('set local role app_user');
    return fn(tx);
  });
}
// #endregion with-tenant
