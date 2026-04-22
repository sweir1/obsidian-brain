import type { DatabaseHandle } from './db.js';
import type { SearchResult } from '../types.js';
import { escapeFts5Query } from './fts5-escape.js';

interface FtsRow {
  id: string;
  title: string;
  score: number;
  excerpt: string | null;
}

/**
 * FTS5 search across node titles + content.
 *
 * Uses an explicit bm25() with column weights 5.0 (title) and 1.0 (content)
 * so literal-token matches in the title rank above equally-literal matches
 * in the body — the common case when a user types a note name. We negate
 * bm25's output (lower-is-better) so SearchResult.score stays
 * higher-is-better, matching the semantic-search convention.
 */
export function searchFullText(
  db: DatabaseHandle,
  query: string,
  limit = 20,
): SearchResult[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.title,
              bm25(nodes_fts, 5.0, 1.0) AS score,
              snippet(nodes_fts, 1, '>>>', '<<<', '...', 40) as excerpt
         FROM nodes_fts f
         JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .all(escapeFts5Query(query), limit) as FtsRow[];

  return rows.map((row) => ({
    nodeId: row.id,
    title: row.title,
    score: -row.score,
    excerpt: row.excerpt ?? '',
  }));
}
