import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { upsertNode } from '../../../src/store/nodes.js';
import { insertEdge, getEdgesByTarget } from '../../../src/store/edges.js';
import { moveNote } from '../../../src/vault/mover.js';
import { rewriteInboundLinks } from '../../../src/tools/move-note.js';

/**
 * v1.6.3 — `renameNode` preserves inbound edges through move_note, replacing
 * the prior delete-then-upsert flow (indexer's deletion detection dropped
 * every inbound edge and depended on source rewrites + reparse to rebuild
 * them).
 *
 * This test simulates the move_note handler's sequence without spinning a
 * live pipeline: rewrite inbound files on disk (while DB edges still point
 * at oldPath), then rename in the DB. After both steps the inbound edges
 * must be attached to newPath directly — no gap where they disappeared.
 */
describe('move_note preserves inbound edges via renameNode (v1.6.3)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-v1-6-3-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('inbound edges survive a rename + link-rewrite cycle without any reparse', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(join(vault, 'a.md'), 'See [[target]] today.\n', 'utf-8');
    await writeFile(join(vault, 'b.md'), 'Reference to [[target]].\n', 'utf-8');

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'target.md', context: 'see' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'target.md', context: 'ref' });

    const moved = await moveNote(vault, 'target.md', 'renamed.md');

    // Rewrite source files on disk BEFORE touching the DB. The rewrite
    // queries edges keyed on the old path, so renameNode must run AFTER.
    await rewriteInboundLinks(db, vault, moved.oldPath, moved.newPath);

    // Atomic DB rename — inbound edges repoint.
    const { renameNode } = await import('../../../src/store/rename.js');
    renameNode(db, moved.oldPath, moved.newPath);

    const stillOnOld = getEdgesByTarget(db, 'target.md');
    const onNew = getEdgesByTarget(db, 'renamed.md');
    expect(stillOnOld).toHaveLength(0);
    expect(onNew).toHaveLength(2);
    expect(new Set(onNew.map((e) => e.sourceId))).toEqual(new Set(['a.md', 'b.md']));
    expect(new Set(onNew.map((e) => e.context))).toEqual(new Set(['see', 'ref']));

    expect(await readFile(join(vault, 'a.md'), 'utf-8')).toBe('See [[renamed]] today.\n');
    expect(await readFile(join(vault, 'b.md'), 'utf-8')).toBe('Reference to [[renamed]].\n');
  });
});
