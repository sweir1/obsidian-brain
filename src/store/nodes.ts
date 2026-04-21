import type { DatabaseHandle } from './db.js';
import type { ParsedNode } from '../types.js';
import { deleteEdgesBySource, deleteEdgesByTarget } from './edges.js';
import { deleteSyncPath } from './sync.js';
import { pruneNodeFromCommunities } from './communities.js';

/**
 * Insert or replace a node. Keeps the FTS5 shadow table in sync — FTS5 with
 * content='nodes' requires an explicit 'delete' command using the OLD values
 * before reinserting, otherwise the FTS index will drift.
 */
export function upsertNode(db: DatabaseHandle, node: ParsedNode): void {
  const existing = db
    .prepare('SELECT rowid, title, content FROM nodes WHERE id = ?')
    .get(node.id) as { rowid: number; title: string; content: string } | undefined;

  if (existing) {
    db.prepare(
      "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
    ).run(existing.rowid, existing.title, existing.content);
  }

  db.prepare(
    `INSERT INTO nodes (id, title, content, frontmatter)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       frontmatter = excluded.frontmatter`
  ).run(node.id, node.title, node.content, JSON.stringify(node.frontmatter));

  const row = db
    .prepare('SELECT rowid FROM nodes WHERE id = ?')
    .get(node.id) as { rowid: number };

  db.prepare(
    'INSERT INTO nodes_fts(rowid, title, content) VALUES(?, ?, ?)'
  ).run(row.rowid, node.title, node.content);
}

/**
 * Fetch a node by id, including its internal rowid (needed for FTS5 / vec0
 * joins).
 */
export function getNode(
  db: DatabaseHandle,
  id: string
): (ParsedNode & { rowid: number }) | undefined {
  const row = db
    .prepare('SELECT rowid, id, title, content, frontmatter FROM nodes WHERE id = ?')
    .get(id) as
    | { rowid: number; id: string; title: string; content: string; frontmatter: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
    rowid: row.rowid,
  };
}

/**
 * Return every node id in the database.
 */
export function allNodeIds(db: DatabaseHandle): string[] {
  return db.prepare('SELECT id FROM nodes').all().map((r) => (r as { id: string }).id);
}

/**
 * Remove a node and every piece of state that references it: FTS5 row,
 * vec0 embedding, incoming + outgoing edges, and sync-state entry.
 */
export function deleteNode(db: DatabaseHandle, id: string): void {
  const row = db
    .prepare('SELECT rowid, title, content FROM nodes WHERE id = ?')
    .get(id) as { rowid: number; title: string; content: string } | undefined;

  if (row) {
    db.prepare(
      "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
    ).run(row.rowid, row.title, row.content);
    // Inlined vec0 delete to avoid a nodes.ts -> embeddings.ts import cycle
    // (embeddings.ts already imports getNode from this file). sqlite-vec
    // requires BigInt rowids via better-sqlite3.
    db.prepare('DELETE FROM nodes_vec WHERE rowid = ?').run(BigInt(row.rowid));
  }

  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  deleteEdgesBySource(db, id);
  deleteEdgesByTarget(db, id);
  deleteSyncPath(db, id);
  // Keep the theme / community cache honest — orphaned ids in `node_ids`
  // arrays were bleeding across sessions before this call landed.
  pruneNodeFromCommunities(db, id);
}
