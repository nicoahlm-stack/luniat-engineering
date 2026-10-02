import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { responseCacheKey } from './cache.ts';
import { currentTenant, runAuthenticated } from './context.ts';
import { decryptForTenant, encryptForTenant } from './secrets.ts';
import { withTenant, type TxDb } from './tenant-db.ts';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
let pg: PGlite;
const db = (): TxDb => ({ transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) as never })) });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('./rls.sql', import.meta.url), 'utf8'));
  await withTenant(db(), A, (tx) => tx.query(`insert into conversations (title) values ('A: refund question')`));
  await withTenant(db(), B, (tx) => tx.query(`insert into conversations (title) values ('B: invoice dispute')`));
}, 60_000);

describe('row-level security', () => {
  it('each tenant sees only its own rows', async () => {
    const a = await withTenant(db(), A, (tx) => tx.query<{ title: string }>('select title from conversations'));
    const b = await withTenant(db(), B, (tx) => tx.query<{ title: string }>('select title from conversations'));
    expect(a.rows.map((r) => r.title)).toEqual(['A: refund question']);
    expect(b.rows.map((r) => r.title)).toEqual(['B: invoice dispute']);
  });

  it('cannot write a row for another tenant', async () => {
    await expect(withTenant(db(), A, (tx) => tx.query('insert into conversations (tenant_id, title) values ($1, $2)', [B, 'planted'])))
      .rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant\'s rows (zero rows affected)', async () => {
    const upd = await withTenant(db(), A, (tx) => tx.query(`update conversations set title = 'hijacked' where title like 'B:%' returning id`));
    const del = await withTenant(db(), A, (tx) => tx.query(`delete from conversations where title like 'B:%' returning id`));
    expect(upd.rows).toEqual([]);
    expect(del.rows).toEqual([]);
  });

  it('fails closed when no tenant is set', async () => {
    const rows = await pg.transaction(async (tx) => {
      await tx.query('set local role app_user');
      return (await tx.query('select * from conversations')).rows;
    });
    expect(rows).toEqual([]);
  });

  it('does not leak the tenant setting to the next transaction on the same connection', async () => {
    await withTenant(db(), A, async () => undefined);
    const setting = await pg.query<{ v: string | null }>(`select current_setting('app.tenant_id', true) as v`);
    expect(setting.rows[0]!.v ?? '').toBe('');
  });

  it('has no unconditionally open policies, and the audit catches one', async () => {
    expect((await pg.query('select * from open_policies')).rows).toEqual([]);
    await pg.exec('create policy "Allow all" on conversations for all to public using (true) with check (true)');
    const open = await pg.query<{ policyname: string }>('select policyname from open_policies');
    await pg.exec('drop policy "Allow all" on conversations');
    expect(open.rows.map((r) => r.policyname)).toEqual(['Allow all']);
  });

  it('rejects malformed tenant ids before touching the database', async () => {
    await expect(withTenant(db(), "a' or '1'='1", async () => undefined)).rejects.toThrow('invalid tenant id');
  });
});

describe('tenant context', () => {
  const verify = async (t: string) => (t === 'valid' ? { userId: 'u1', tenantId: A } : null);

  it('is set from the verified credential and nothing else', async () => {
    await expect(runAuthenticated('valid', verify, async () => currentTenant())).resolves.toBe(A);
    await expect(runAuthenticated('forged', verify, async () => currentTenant())).rejects.toMatchObject({ status: 401 });
    expect(() => currentTenant()).toThrow('no tenant in context');
  });
});

describe('response cache keys', () => {
  it('differ by tenant and ignore key order', () => {
    const base = { model: 'default', promptHash: 'abc', inputs: { q: 'refund', lang: 'sv' } };
    expect(responseCacheKey({ tenantId: A, ...base })).not.toBe(responseCacheKey({ tenantId: B, ...base }));
    expect(responseCacheKey({ tenantId: A, ...base })).toBe(responseCacheKey({ tenantId: A, ...base, inputs: { lang: 'sv', q: 'refund' } }));
    expect(responseCacheKey({ tenantId: A, ...base })).toMatch(/^llm:v1:0{8}-0{4}-0{4}-0{4}-0{11}a:[0-9a-f]{64}$/);
  });
});

describe('per-tenant secrets', () => {
  const key = randomBytes(32);
  it('round-trips for the right tenant and fails for any other', () => {
    const token = encryptForTenant('sk-tenant-a-provider-key', A, key);
    expect(decryptForTenant(token, A, key)).toBe('sk-tenant-a-provider-key');
    expect(() => decryptForTenant(token, B, key)).toThrow(/authenticate/);
    expect(token).not.toContain('sk-tenant');
  });
});
