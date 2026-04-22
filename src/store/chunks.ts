import type { DatabaseHandle } from './db.js';
import type { Chunk } from '../embeddings/chunker.js';
import { chunkId } from '../embeddings/chunker.js';

/**
 * Row as stored in the chunks table. Vector lives in chunks_vec keyed by
 * rowid; callers that need it look it up via joinChunkVector.
 */
export interface ChunkRow {
  id: string;
  nodeId: string;
  chunkIndex: number;
  heading: string | null;
  headingLevel: number | null;
  content: string;
  contentHash: string;
  startLine: number | null;
  endLine: number | null;
  rowid: number;
}

/**
 * Upsert a single chunk row. Returns the assigned rowid — callers pair it
 * with upsertChunkVector to keep chunks_vec in sync.
 */
export function upsertChunkRow(
  db: DatabaseHandle,
  nodeId: string,
  chunk: Chunk,
): number {
  const id = chunkId(nodeId, chunk.chunkIndex);
  db.prepare(
    `INSERT INTO chunks
       (id, node_id, chunk_index, heading, heading_level, content, content_hash, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       node_id        = excluded.node_id,
       chunk_index    = excluded.chunk_index,
       heading        = excluded.heading,
       heading_level  = excluded.heading_level,
       content        = excluded.content,
       content_hash   = excluded.content_hash,
       start_line     = excluded.start_line,
       end_line       = excluded.end_line`,
  ).run(
    id,
    nodeId,
    chunk.chunkIndex,
    chunk.heading,
    chunk.headingLevel,
    chunk.content,
    chunk.contentHash,
    chunk.startLine,
    chunk.endLine,
  );
  const row = db.prepare('SELECT rowid FROM chunks WHERE id = ?').get(id) as { rowid: number };
  return row.rowid;
}

/**
 * Write `vector` into chunks_vec at `rowid`, replacing any existing row.
 */
export function upsertChunkVector(
  db: DatabaseHandle,
  rowid: number,
  vector: Float32Array,
): void {
  db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(rowid));
  db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)').run(
    BigInt(rowid),
    Buffer.from(vector.buffer),
  );
}

/**
 * Look up a chunk by composite id (returns undefined if missing). Used by
 * the indexer to cheap-skip re-embedding when content_hash matches.
 */
export function getChunk(
  db: DatabaseHandle,
  id: string,
): ChunkRow | undefined {
  const row = db
    .prepare(
      `SELECT rowid, id, node_id, chunk_index, heading, heading_level,
              content, content_hash, start_line, end_line
         FROM chunks WHERE id = ?`,
    )
    .get(id) as
    | {
        rowid: number;
        id: string;
        node_id: string;
        chunk_index: number;
        heading: string | null;
        heading_level: number | null;
        content: string;
        content_hash: string;
        start_line: number | null;
        end_line: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    nodeId: row.node_id,
    chunkIndex: row.chunk_index,
    heading: row.heading,
    headingLevel: row.heading_level,
    content: row.content,
    contentHash: row.content_hash,
    startLine: row.start_line,
    endLine: row.end_line,
    rowid: row.rowid,
  };
}

/**
 * IDs of every chunk currently stored for `nodeId`. Used by the indexer to
 * diff fresh-vs-stale chunks after a note is re-parsed.
 */
export function getChunkIdsForNode(db: DatabaseHandle, nodeId: string): string[] {
  return db
    .prepare('SELECT id FROM chunks WHERE node_id = ? ORDER BY chunk_index')
    .all(nodeId)
    .map((r) => (r as { id: string }).id);
}

/**
 * Delete a set of chunks (and their vectors) by composite id.
 */
export function deleteChunks(db: DatabaseHandle, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT rowid FROM chunks WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ rowid: number }>;
  for (const r of rows) {
    db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(r.rowid));
  }
  db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Delete every chunk for `nodeId`. Called when a note is removed (the
 * chunks table's ON DELETE CASCADE covers the SQL rows, but chunks_vec is
 * a separate virtual table without FK cascade — so we vacuum it here).
 */
export function deleteChunksForNode(db: DatabaseHandle, nodeId: string): void {
  const rows = db
    .prepare('SELECT rowid FROM chunks WHERE node_id = ?')
    .all(nodeId) as Array<{ rowid: number }>;
  for (const r of rows) {
    db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(r.rowid));
  }
  db.prepare('DELETE FROM chunks WHERE node_id = ?').run(nodeId);
}

/**
 * Total number of chunks in the store. Used at startup to decide whether a
 * chunk-level reindex is needed (new DB, or pre-1.4.0 upgrade).
 */
export function countChunks(db: DatabaseHandle): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
}

/**
 * kNN search over chunks_vec, joining chunks for metadata.
 *
 * Returns one row per matching chunk. Callers that want one-per-note
 * dedup should group by nodeId and keep the max-scoring chunk (see
 * Search.semanticChunks in src/search/unified.ts).
 */
export interface ChunkSearchHit {
  chunkId: string;
  nodeId: string;
  chunkIndex: number;
  heading: string | null;
  headingLevel: number | null;
  content: string;
  startLine: number | null;
  endLine: number | null;
  score: number;
  title: string;
}

export function searchChunkVectors(
  db: DatabaseHandle,
  vector: Float32Array,
  limit: number,
): ChunkSearchHit[] {
  return db
    .prepare(
      `SELECT v.rowid, v.distance,
              c.id AS chunk_id, c.node_id, c.chunk_index,
              c.heading, c.heading_level, c.content,
              c.start_line, c.end_line,
              n.title
         FROM chunks_vec v
         JOIN chunks c ON c.rowid = v.rowid
         JOIN nodes  n ON n.id    = c.node_id
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(Buffer.from(vector.buffer), limit)
    .map((r) => {
      const row = r as {
        rowid: number;
        distance: number;
        chunk_id: string;
        node_id: string;
        chunk_index: number;
        heading: string | null;
        heading_level: number | null;
        content: string;
        start_line: number | null;
        end_line: number | null;
        title: string;
      };
      return {
        chunkId: row.chunk_id,
        nodeId: row.node_id,
        chunkIndex: row.chunk_index,
        heading: row.heading,
        headingLevel: row.heading_level,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 - row.distance,
        title: row.title,
      };
    });
}
