import type { DatabaseHandle } from './db.js';
import type { ParsedNode } from '../types.js';
import { deleteEdgesBySource, deleteEdgesByTarget, countEdgesByTarget } from './edges.js';
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

  // Drop per-chunk embeddings + rows keyed on this node. The chunks table
  // itself has ON DELETE CASCADE from nodes, but chunks_vec is a virtual
  // table without FK cascade — so we vacuum its rowids first.
  const chunkRows = db
    .prepare('SELECT rowid FROM chunks WHERE node_id = ?')
    .all(id) as Array<{ rowid: number }>;
  for (const cr of chunkRows) {
    db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(cr.rowid));
  }
  db.prepare('DELETE FROM chunks WHERE node_id = ?').run(id);

  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  deleteEdgesBySource(db, id);
  deleteEdgesByTarget(db, id);
  deleteSyncPath(db, id);
  // Keep the theme / community cache honest — orphaned ids in `node_ids`
  // arrays were bleeding across sessions before this call landed.
  pruneNodeFromCommunities(db, id);
}

/**
 * Delete every stub node in `candidateIds` that has zero inbound edges.
 * "Stub" is identified by frontmatter._stub === true.
 * Non-stub ids and missing ids are skipped silently.
 * Returns the count of nodes pruned.
 */
export function pruneOrphanStubs(db: DatabaseHandle, candidateIds: string[]): number {
  let pruned = 0;
  for (const id of candidateIds) {
    if (!id.startsWith('_stub/')) continue;
    const node = getNode(db, id);
    if (!node) continue;
    if (node.frontmatter._stub !== true) continue;
    if (countEdgesByTarget(db, id) !== 0) continue;
    deleteNode(db, id);
    pruned++;
  }
  return pruned;
}

/**
 * Sweep all stubs in the DB and prune any with zero inbound edges.
 * Used as a backstop in reindex() and as the migration path for
 * existing v1.5.7 users with orphan stubs.
 */
export function pruneAllOrphanStubs(db: DatabaseHandle): number {
  const rows = db
    .prepare("SELECT id FROM nodes WHERE json_extract(frontmatter, '$._stub') = 1")
    .all() as Array<{ id: string }>;
  const candidateIds = rows.map((r) => r.id);
  return pruneOrphanStubs(db, candidateIds);
}

/**
 * When a real note is created that matches an existing stub's path,
 * repoint all inbound edges from the stub to the real node and delete
 * the stub. No-op if the stub doesn't exist or isn't actually a stub.
 */
export function migrateStubToReal(db: DatabaseHandle, stubId: string, realId: string): void {
  const node = getNode(db, stubId);
  if (!node) return;
  if (node.frontmatter._stub !== true) return;
  db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run(realId, stubId);
  deleteNode(db, stubId);
}
