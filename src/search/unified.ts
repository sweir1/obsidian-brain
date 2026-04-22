import type { DatabaseHandle } from '../store/db.js';
import { searchVector } from '../store/embeddings.js';
import { searchFullText } from '../store/fulltext.js';
import { searchChunkVectors, countChunks, type ChunkSearchHit } from '../store/chunks.js';
import type { Embedder } from '../embeddings/embedder.js';
import type { SearchResult } from '../types.js';

/**
 * Extra fields attached to a SearchResult when the hit came from a
 * particular chunk. Kept optional on the base type so existing callers
 * that ignore them keep compiling.
 */
export interface ChunkAwareResult extends SearchResult {
  chunkId?: string;
  chunkHeading?: string | null;
  chunkStartLine?: number | null;
  chunkEndLine?: number | null;
  chunkExcerpt?: string;
}

export type SearchUnique = 'notes' | 'chunks';

export class Search {
  constructor(
    private db: DatabaseHandle,
    private embedder: Embedder,
  ) {}

  /**
   * Semantic search. Since v1.4.0 this is backed by chunks_vec — the
   * top-scoring chunk per note wins, and we return one row per note by
   * default. Falls back to the legacy note-level nodes_vec path if the
   * chunks table is empty (e.g. brand-new DB before the first index run).
   */
  async semantic(query: string, limit = 20): Promise<SearchResult[]> {
    if (countChunks(this.db) === 0) {
      const qEmb = await this.embedder.embed(query, 'query');
      return searchVector(this.db, qEmb, limit);
    }
    return this.semanticChunks(query, limit, 'notes');
  }

  /**
   * Chunk-aware semantic search. Over-fetch raw chunk hits, then either
   * dedupe to one-per-note (unique='notes') or keep raw chunk rows
   * (unique='chunks'). Useful when the caller wants the exact heading +
   * line span that matched.
   */
  async semanticChunks(
    query: string,
    limit = 20,
    unique: SearchUnique = 'notes',
  ): Promise<ChunkAwareResult[]> {
    const qEmb = await this.embedder.embed(query, 'query');
    // Over-fetch so dedup-by-note still returns ~`limit` rows.
    const raw = searchChunkVectors(this.db, qEmb, limit * 4);
    if (unique === 'chunks') {
      return raw.slice(0, limit).map(toChunkAwareResult);
    }
    const byNode = new Map<string, ChunkSearchHit>();
    for (const hit of raw) {
      const prev = byNode.get(hit.nodeId);
      if (!prev || hit.score > prev.score) byNode.set(hit.nodeId, hit);
    }
    return [...byNode.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(toChunkAwareResult);
  }

  fulltext(query: string, limit = 20): SearchResult[] {
    return searchFullText(this.db, query, limit);
  }

  /**
   * Hybrid retrieval: run semantic + full-text in parallel, fuse ranks via
   * Reciprocal Rank Fusion (RRF). No tuning knobs — RRF is robust enough
   * out of the box that we make this the new default.
   */
  async hybrid(query: string, limit = 20): Promise<SearchResult[]> {
    // Over-fetch each list so rare-in-one-side-but-strong hits still land
    // in the fused top-`limit`.
    const [sem, fts] = await Promise.all([
      this.semantic(query, limit * 2),
      Promise.resolve(this.fulltext(query, limit * 2)),
    ]);
    const fused = reciprocalRankFusion<SearchResult>(
      [sem, fts],
      (r) => r.nodeId,
    );
    return fused.slice(0, limit).map((r) => ({
      nodeId: r.item.nodeId,
      title: r.item.title,
      score: r.score,
      excerpt: r.item.excerpt,
    }));
  }
}

function toChunkAwareResult(hit: ChunkSearchHit): ChunkAwareResult {
  return {
    nodeId: hit.nodeId,
    title: hit.title,
    score: hit.score,
    excerpt: excerpt(hit.content, 200),
    chunkId: hit.chunkId,
    chunkHeading: hit.heading,
    chunkStartLine: hit.startLine,
    chunkEndLine: hit.endLine,
    chunkExcerpt: excerpt(hit.content, 200),
  };
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed;
}

/**
 * Reciprocal Rank Fusion across an arbitrary number of ranked lists.
 *
 * RRF score for item `i` seen at rank `r` in any list: `1 / (k + r)`, summed
 * across lists. `k = 60` is Cormack, Clarke & Büttcher's tuned constant from
 * the original 2009 paper — good enough that our callers don't need to tune.
 *
 * Returns `{item, score}` ordered by descending score. `keyFn` maps each
 * item to the id used for deduping — callers pass `r => r.nodeId` for
 * note-level fusion.
 */
export function reciprocalRankFusion<T>(
  lists: T[][],
  keyFn: (item: T) => string,
  k = 60,
): Array<{ item: T; score: number }> {
  const agg = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const id = keyFn(item);
      const contrib = 1 / (k + idx + 1);
      const prev = agg.get(id);
      if (prev) prev.score += contrib;
      else agg.set(id, { item, score: contrib });
    });
  }
  return [...agg.values()].sort((a, b) => b.score - a.score);
}
