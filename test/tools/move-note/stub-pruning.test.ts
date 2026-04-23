import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { upsertNode, allNodeIds, pruneOrphanStubs } from '../../../src/store/nodes.js';
import { insertEdge } from '../../../src/store/edges.js';
import { moveNote } from '../../../src/vault/mover.js';
import { rewriteInboundLinks } from '../../../src/tools/move-note.js';

/**
 * Regression test for v1.5.8-C: move_note must prune orphan stubs that
 * accumulated for the old stem after link rewriting completes.
 *
 * Mirrors the field reproduction from feedback/obsidian-brain-verification-v1-5-7-2.md:
 *   _move_source.md has [[_move_target#Section A]]
 *   _move_target.md is then renamed → _move_target_renamed.md
 *   Stubs _stub/_move_target.md and _stub/_move_target#Section A.md must be
 *   deleted (zero inbound edges after the link rewrite).
 */
describe('move-note stub pruning (v1.5.8-C regression)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-move-stub-prune-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('pruneOrphanStubs removes stubs matching old stem that have zero inbound edges', () => {
    const stubPlain = '_stub/_move_target.md';
    const stubSection = '_stub/_move_target#Section A.md';

    upsertNode(db, {
      id: stubPlain,
      title: '_move_target',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertNode(db, {
      id: stubSection,
      title: '_move_target#Section A',
      content: '',
      frontmatter: { _stub: true },
    });

    // Source note present but no inbound edges — post-rewrite state: stubs are orphaned.
    upsertNode(db, {
      id: '_move_source.md',
      title: '_move_source',
      content: '[[_move_target#Section A]]',
      frontmatter: {},
    });

    const oldStem = '_move_target';
    const candidates = allNodeIds(db).filter((id) =>
      id.startsWith(`_stub/${oldStem}`),
    );
    expect(candidates).toContain(stubPlain);
    expect(candidates).toContain(stubSection);

    const pruned = pruneOrphanStubs(db, candidates);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const remaining = allNodeIds(db);
    expect(remaining).not.toContain(stubPlain);
    expect(remaining).not.toContain(stubSection);
  });

  it('does not prune stubs that still have inbound edges', () => {
    const stubId = '_stub/_move_target.md';
    upsertNode(db, {
      id: stubId,
      title: '_move_target',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertNode(db, {
      id: '_other_source.md',
      title: 'Other',
      content: '',
      frontmatter: {},
    });
    insertEdge(db, { sourceId: '_other_source.md', targetId: stubId, context: 'link' });

    const pruned = pruneOrphanStubs(db, [stubId]);
    expect(pruned).toBe(0);

    expect(allNodeIds(db)).toContain(stubId);
  });

  it('full move flow: rewrite then prune leaves no orphan stubs for old stem', async () => {
    await writeFile(join(vault, '_move_target.md'), '# Move Target\n', 'utf-8');
    await writeFile(
      join(vault, '_move_source.md'),
      'See [[_move_target#Section A]] for context.\n',
      'utf-8',
    );

    upsertNode(db, {
      id: '_move_target.md',
      title: '_move_target',
      content: '',
      frontmatter: {},
    });
    upsertNode(db, {
      id: '_move_source.md',
      title: '_move_source',
      content: '',
      frontmatter: {},
    });
    const stubPlain = '_stub/_move_target.md';
    const stubSection = '_stub/_move_target#Section A.md';
    upsertNode(db, {
      id: stubPlain,
      title: '_move_target',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertNode(db, {
      id: stubSection,
      title: '_move_target#Section A',
      content: '',
      frontmatter: { _stub: true },
    });

    insertEdge(db, {
      sourceId: '_move_source.md',
      targetId: stubSection,
      context: 'link',
    });
    insertEdge(db, {
      sourceId: '_move_source.md',
      targetId: stubPlain,
      context: 'link',
    });

    const moveResult = await moveNote(vault, '_move_target.md', '_move_target_renamed.md');

    await rewriteInboundLinks(db, vault, moveResult.oldPath, moveResult.newPath);

    // Mirror post-rewrite state: clear stale edges to the old stubs.
    db.prepare('DELETE FROM edges WHERE source_id = ? AND target_id = ?').run(
      '_move_source.md',
      stubSection,
    );
    db.prepare('DELETE FROM edges WHERE source_id = ? AND target_id = ?').run(
      '_move_source.md',
      stubPlain,
    );

    const oldStem = '_move_target';
    const candidates = allNodeIds(db).filter((id) =>
      id.startsWith(`_stub/${oldStem}`),
    );
    const stubsPruned = pruneOrphanStubs(db, candidates);

    expect(stubsPruned).toBeGreaterThanOrEqual(1);

    const remaining = allNodeIds(db);
    expect(remaining).not.toContain(stubPlain);
    expect(remaining).not.toContain(stubSection);
  });
});
