import type { DatabaseHandle } from './db.js';
import type { Community } from '../types.js';

interface CommunityRow {
  id: number;
  label: string;
  summary: string;
  node_ids: string;
}

export function upsertCommunity(db: DatabaseHandle, c: Community): void {
  db.prepare(
    `INSERT INTO communities (id, label, summary, node_ids) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       summary = excluded.summary,
       node_ids = excluded.node_ids`,
  ).run(c.id, c.label, c.summary, JSON.stringify(c.nodeIds));
}

export function clearCommunities(db: DatabaseHandle): void {
  db.prepare('DELETE FROM communities').run();
}

/**
 * Remove `nodeId` from every community row's `node_ids` array. If a row
 * becomes empty after pruning, delete the row entirely. Cheap: O(communities).
 *
 * Called from `deleteNode` so the theme / community cache doesn't accumulate
 * ghost ids across sessions when vault files are removed.
 */
export function pruneNodeFromCommunities(db: DatabaseHandle, nodeId: string): void {
  const rows = db
    .prepare('SELECT id, label, summary, node_ids FROM communities')
    .all() as CommunityRow[];
  const updateStmt = db.prepare('UPDATE communities SET node_ids = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM communities WHERE id = ?');
  for (const row of rows) {
    const ids = JSON.parse(row.node_ids) as string[];
    if (!ids.includes(nodeId)) continue;
    const pruned = ids.filter((id) => id !== nodeId);
    if (pruned.length === 0) {
      deleteStmt.run(row.id);
    } else {
      updateStmt.run(JSON.stringify(pruned), row.id);
    }
  }
}

export function getAllCommunities(db: DatabaseHandle): Community[] {
  const rows = db
    .prepare('SELECT id, label, summary, node_ids FROM communities')
    .all() as CommunityRow[];
  return rows.map(rowToCommunity);
}

/**
 * Look up a community by numeric id (passed as string or number) or by label
 * match. Returns the first hit. Labels are matched exactly.
 */
export function getCommunity(
  db: DatabaseHandle,
  idOrLabel: string | number,
): Community | null {
  const asNumber = typeof idOrLabel === 'number' ? idOrLabel : Number(idOrLabel);
  const numericId = Number.isFinite(asNumber) ? asNumber : -1;
  const label = typeof idOrLabel === 'string' ? idOrLabel : String(idOrLabel);
  const row = db
    .prepare(
      'SELECT id, label, summary, node_ids FROM communities WHERE id = ? OR label = ? LIMIT 1',
    )
    .get(numericId, label) as CommunityRow | undefined;
  return row ? rowToCommunity(row) : null;
}

function rowToCommunity(row: CommunityRow): Community {
  return {
    id: row.id,
    label: row.label,
    summary: row.summary,
    nodeIds: JSON.parse(row.node_ids) as string[],
  };
}
