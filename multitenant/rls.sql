-- #region rls
-- The application connects as a role that owns nothing and bypasses nothing.
create role app_user nologin;

create table conversations (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid,
  title      text not null,
  created_at timestamptz not null default now()
);
create index conversations_tenant_idx on conversations (tenant_id);

alter table conversations enable row level security;
-- Also applies RLS to the table owner, so a migration or admin script that
-- forgets to switch role does not silently see every tenant.
alter table conversations force row level security;

-- One policy per command, all keyed on the same setting. If the setting is
-- missing the comparison is NULL and every row is filtered out: the failure
-- mode is "nothing", never "everything". nullif is needed because once a
-- connection has set the variable, it reads as '' (not NULL) after the
-- transaction ends, and ''::uuid is an error rather than an empty result.
create policy tenant_select on conversations for select to app_user
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_insert on conversations for insert to app_user
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_update on conversations for update to app_user
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_delete on conversations for delete to app_user
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on conversations to app_user;
-- #endregion rls

-- #region audit
-- Run in CI: no policy on a tenant table may be unconditionally true for
-- client roles. A policy created with "true" in a hurry turns every other
-- policy on the table into decoration, because permissive policies are ORed.
create view open_policies as
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where (qual = 'true' or with_check = 'true')
  and roles && array['public', 'app_user']::name[];
-- #endregion audit
