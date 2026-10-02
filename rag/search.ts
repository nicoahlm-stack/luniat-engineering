/** Minimal query interface: PGlite in tests, node-postgres or similar in production. */
export interface Db {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export interface Hit {
  id: number;
  documentId: number;
  heading: string;
  body: string;
  score: number;
}

// #region hybrid
/**
 * Hybrid retrieval in one round trip: the top candidates from vector search
 * and from full-text search are fused with Reciprocal Rank Fusion (RRF).
 * RRF uses ranks, not scores, so cosine distance and ts_rank never have to
 * be put on the same scale. k = 60 is the constant from the original paper.
 *
 * The tenant filter is part of both candidate queries. Retrieval is where
 * cross-tenant leaks happen in RAG systems, so it is never optional here.
 */
export const HYBRID_SQL = `
with semantic as (
  select id, row_number() over (order by embedding <=> $2::vector) as rank
  from chunks
  where tenant_id = $1
  order by embedding <=> $2::vector
  limit $4
),
lexical as (
  select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as rank
  from chunks, websearch_to_tsquery('simple', $3) as q
  where tenant_id = $1 and tsv @@ q
  order by ts_rank_cd(tsv, q) desc
  limit $4
),
fused as (
  select coalesce(s.id, l.id) as id,
         coalesce(1.0 / ($5 + s.rank), 0) + coalesce(1.0 / ($5 + l.rank), 0) as score
  from semantic s
  full outer join lexical l on s.id = l.id
)
select c.id, c.document_id as "documentId", c.heading, c.body, f.score::float8 as score
from fused f
join chunks c on c.id = f.id
order by f.score desc, c.id
limit $6`;

export interface SearchOptions {
  /** Candidates taken from each retriever before fusion. */
  candidates: number;
  /** Results returned after fusion. */
  limit: number;
  /** RRF constant. */
  k?: number;
}

export async function hybridSearch(db: Db, tenantId: string, query: string, embedding: number[], o: SearchOptions): Promise<Hit[]> {
  const vec = `[${embedding.join(',')}]`;
  const { rows } = await db.query<Hit>(HYBRID_SQL, [tenantId, vec, query, o.candidates, o.k ?? 60, o.limit]);
  return rows;
}
// #endregion hybrid
