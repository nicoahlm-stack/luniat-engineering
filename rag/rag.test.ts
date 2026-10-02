import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkMarkdown, embeddingText } from './chunk.ts';
import { buildContext, checkCitations } from './context.ts';
import { evaluateRetrieval, reciprocalRank, recallAtK } from './metrics.ts';
import { hybridSearch, type Db } from './search.ts';

/**
 * Test-only embedding: hashed bag of words, 64 dimensions, L2-normalised.
 * It captures word overlap and nothing else, which is enough to test the
 * SQL and the fusion logic deterministically without a model.
 */
function toyEmbed(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = createHash('sha1').update(w).digest();
    v[h[0]! % 64]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

let db: PGlite;

async function ingest(tenant: string, uri: string, md: string) {
  const doc = await db.query<{ id: number }>(
    'insert into documents (tenant_id, source_uri, content_sha) values ($1, $2, $3) returning id',
    [tenant, uri, createHash('sha256').update(md).digest('hex')],
  );
  for (const c of chunkMarkdown(md, { maxTokens: 120, overlapParagraphs: 1 })) {
    await db.query('insert into chunks (tenant_id, document_id, ord, heading, body, embedding) values ($1, $2, $3, $4, $5, $6)',
      [tenant, doc.rows[0]!.id, c.ord, c.heading, c.body, `[${toyEmbed(embeddingText(c)).join(',')}]`]);
  }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await ingest(A, 'kb://returns', [
    '# Returns', 'You can return any item within 30 days of delivery.',
    '## Damaged goods', 'If an item arrives damaged, send a photo and we ship a replacement at no cost.',
    '## Error codes', 'Error E1042 means the return label has expired. Request a new label from your order page.',
  ].join('\n\n'));
  await ingest(A, 'kb://shipping', ['# Shipping', 'Orders ship within two business days from our warehouse in Borås.'].join('\n\n'));
  await ingest(B, 'kb://returns', ['# Returns', 'Tenant B accepts returns within 14 days. Error E1042 is not used by tenant B.'].join('\n\n'));
}, 60_000);

const pg = (): Db => ({ query: (sql, params) => db.query(sql, params) as never });
const search = (tenant: string, q: string) => hybridSearch(pg(), tenant, q, toyEmbed(q), { candidates: 20, limit: 5 });

describe('chunking', () => {
  it('splits on headings and keeps the heading path', () => {
    const chunks = chunkMarkdown('# Returns\n\nWithin 30 days.\n\n## Damaged goods\n\nSend a photo.', { maxTokens: 200, overlapParagraphs: 0 });
    expect(chunks.map((c) => [c.heading, c.body])).toEqual([['Returns', 'Within 30 days.'], ['Returns > Damaged goods', 'Send a photo.']]);
  });

  it('splits long sections on paragraphs, with overlap, never inside one', () => {
    const para = (n: number) => `Paragraph ${n} ${'x'.repeat(150)}`;
    const chunks = chunkMarkdown(`# Long\n\n${[1, 2, 3, 4].map(para).join('\n\n')}`, { maxTokens: 90, overlapParagraphs: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]!.body.startsWith(chunks[0]!.body.split('\n\n').at(-1)!)).toBe(true);
    for (const c of chunks) for (const p of c.body.split('\n\n')) expect(p).toMatch(/^Paragraph \d x+$/);
  });
});

describe('hybrid search (Postgres + pgvector)', () => {
  it('finds an exact identifier through the lexical side', async () => {
    const hits = await search(A, 'what does E1042 mean');
    expect(hits[0]!.heading).toBe('Returns > Error codes');
  });

  it('never returns another tenant\'s chunks', async () => {
    const a = await search(A, 'returns within days');
    const b = await search(B, 'returns within days');
    expect(a.every((h) => !h.body.includes('Tenant B'))).toBe(true);
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((h) => h.body.includes('Tenant B'))).toBe(true);
  });

  it('fuses with RRF: a chunk found by both retrievers outranks one found by one', async () => {
    const hits = await search(A, 'damaged item replacement photo');
    expect(hits[0]!.heading).toBe('Returns > Damaged goods');
    expect(hits[0]!.score).toBeCloseTo(2 / 61, 6); // rank 1 on both sides with k = 60
  });
});

describe('context and citations', () => {
  const hits = [
    { id: 11, documentId: 1, heading: 'Returns', body: 'Within 30 days.', score: 0.03 },
    { id: 12, documentId: 1, heading: 'Damaged', body: 'Send a "photo".', score: 0.02 },
    { id: 13, documentId: 2, heading: 'Shipping', body: 'x'.repeat(4_000), score: 0.01 },
  ];

  it('packs sources best first within the budget', () => {
    const { sources, text } = buildContext(hits, 200);
    expect(sources.map((s) => s.chunkId)).toEqual([11, 12]);
    expect(text).toContain('<source n="2" title="Damaged">');
  });

  it('rejects hallucinated citations and uncited answers', () => {
    const { sources } = buildContext(hits, 200);
    expect(checkCitations('Returns are accepted within 30 days [1].', sources)).toMatchObject({ ok: true, cited: [1] });
    expect(checkCitations('Within 30 days [1], free shipping [3].', sources)).toMatchObject({ ok: false, invalid: [3] });
    expect(checkCitations('Returns are accepted within 30 days.', sources).ok).toBe(false);
    expect(checkCitations("I don't know based on the provided sources.", sources).ok).toBe(true);
  });
});

describe('retrieval metrics', () => {
  it('computes recall@k and MRR', () => {
    expect(recallAtK([5, 3, 9], new Set([3, 7]), 3)).toBe(0.5);
    expect(reciprocalRank([5, 3, 9], new Set([3, 7]))).toBe(0.5);
    expect(evaluateRetrieval([
      { retrieved: [1, 2], relevant: new Set([1]) },
      { retrieved: [4, 3], relevant: new Set([3]) },
    ], 1)).toEqual({ recall: 0.5, mrr: 0.75 });
  });
});
