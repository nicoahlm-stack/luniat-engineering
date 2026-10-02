-- #region schema
create extension if not exists vector;

create table documents (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  source_uri  text not null,
  -- Hash of the source content: re-ingest only what changed.
  content_sha text not null,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, source_uri)
);

create table chunks (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  document_id bigint not null references documents(id) on delete cascade,
  ord         int not null,
  heading     text not null default '',
  body        text not null,
  -- Dimension must match the embedding model. Changing model = new column + backfill.
  embedding   vector(64) not null,
  -- Lexical index over heading + body, maintained by Postgres.
  tsv         tsvector generated always as (
                setweight(to_tsvector('simple', heading), 'A') ||
                setweight(to_tsvector('simple', body), 'B')) stored,
  unique (document_id, ord)
);

create index chunks_tenant_idx    on chunks (tenant_id);
create index chunks_tsv_idx       on chunks using gin (tsv);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
-- #endregion schema
