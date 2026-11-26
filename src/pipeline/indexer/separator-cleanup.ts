import type { DatabaseHandle } from '../../store/db.js';
import { deleteNode, getNode } from '../../store/nodes.js';

/**
 * Remove note rows whose id contains a `\` and which the current full scan
 * did not produce.
 *
 * **Where they come from.** Before the watcher normalised its ids, every
 * note edited on Windows while the server ran was indexed a second time
 * under a `\`-separated id (`_logs\2026-10-15.md` next to the real
 * `_logs/2026-10-15.md`). The full reindex usually deletes such rows via
 * the sync table, but not when the sync table had been wiped (the
 * model/schema-change bootstrap clears it), and the deletion path drops
 * every inbound edge on the way — so other notes whose links had resolved
 * to the `\` row lost those links until they were edited again.
 *
 * **Why this is safe.** The full scan never emits a `\` separator (it
 * builds ids with `/`), so a `\` id it did not produce is one of:
 *   - a Windows duplicate of a note the scan found under its `/` id —
 *     inbound edges are moved to that twin, then the duplicate is dropped;
 *   - a note whose file no longer exists, or now sits in an excluded
 *     folder — dropped, exactly as the regular deleted-file path would.
 * A POSIX note whose real filename contains `\` IS produced by the scan,
 * so it is in `currentIds` and is never touched. Stub nodes (`_stub/...`)
 * are not files and are left to the orphan-stub pruning.
 *
 * Only index rows are affected; nothing on disk is touched.
 *
 * @returns the number of rows removed.
 */
export function pruneSeparatorDuplicates(
  db: DatabaseHandle,
  currentIds: ReadonlySet<string>,
): number {
  const candidates = db
    .prepare('SELECT id FROM nodes WHERE instr(id, char(92)) > 0')
    .all() as Array<{ id: string }>;

  let removed = 0;
  for (const { id } of candidates) {
    if (currentIds.has(id) || id.startsWith('_stub/')) continue;
    const node = getNode(db, id);
    if (!node || node.frontmatter._stub === true) continue;

    const twin = id.split('\\').join('/');
    if (currentIds.has(twin)) {
      db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run(twin, id);
    }
    deleteNode(db, id);
    removed++;
  }
  return removed;
}
