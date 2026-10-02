export interface Chunk {
  /** Position within the document, for stable ids and for reassembling neighbours. */
  ord: number;
  /** "Refunds > Damaged goods": the heading path, kept as metadata and prepended for embedding. */
  heading: string;
  body: string;
}

export interface ChunkOptions {
  /** Upper bound per chunk, in approximate tokens (characters / 4). */
  maxTokens: number;
  /** Paragraphs repeated at the start of the next chunk when a section is split. */
  overlapParagraphs: number;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

// #region chunk
/**
 * Structure-aware chunking for Markdown: split on headings first, then on
 * paragraphs if a section is too long. Never split inside a paragraph, a
 * list or a table, because a half table retrieves well and answers badly.
 */
export function chunkMarkdown(md: string, o: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let paras: string[] = [];

  const flush = () => {
    const heading = path.filter(Boolean).join(' > ');
    let current: string[] = [];
    for (const p of paras) {
      const candidate = [...current, p].join('\n\n');
      if (current.length && approxTokens(candidate) > o.maxTokens) {
        chunks.push({ ord: chunks.length, heading, body: current.join('\n\n') });
        current = current.slice(-o.overlapParagraphs); // carry context across the split
      }
      current.push(p);
    }
    if (current.length) chunks.push({ ord: chunks.length, heading, body: current.join('\n\n') });
    paras = [];
  };

  for (const block of md.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const h = block.match(/^(#{1,6})\s+(.+)$/);
    if (h && !block.includes('\n')) {
      flush();
      const level = h[1]!.length;
      path.length = level - 1;
      path[level - 1] = h[2]!.trim();
      continue;
    }
    if (block.trim()) paras.push(block.trim());
  }
  flush();
  return chunks;
}

/** What actually gets embedded: the heading path gives a short chunk its context. */
export const embeddingText = (c: Chunk) => (c.heading ? `${c.heading}\n\n${c.body}` : c.body);
// #endregion chunk
