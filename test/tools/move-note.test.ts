import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode, allNodeIds, pruneOrphanStubs } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { moveNote } from '../../src/vault/mover.js';
import { rewriteInboundLinks } from '../../src/tools/move-note.js';

/**
 * Full-flow coverage for the H1 (v1.5.0) eager link rewriter: move a note on
 * disk, then let `rewriteInboundLinks` walk the edge store and rewrite every
 * source file that pointed at the old stem. We drive the pieces directly
 * rather than the MCP tool layer because the tool layer also spins the
 * embedder/indexer, which belongs to a different test tier.
 */
describe('move-note link rewrite flow (H1)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-move-rewrite-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('rewrites a single inbound [[old]] link on move', async () => {
    // Target note (the one being moved) and one source linking to it.
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'See [[target]] for context.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    expect(move.newPath).toBe('renamed.md');

    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 1, occurrences: 1 });

    const src = await readFile(join(vault, 'source.md'), 'utf-8');
    expect(src).toBe('See [[renamed]] for context.\n');
  });

  it('reports zero when nothing links to the moved note', async () => {
    await writeFile(join(vault, 'lonely.md'), '# Lonely\n', 'utf-8');
    upsertNode(db, { id: 'lonely.md', title: 'Lonely', content: '', frontmatter: {} });

    const move = await moveNote(vault, 'lonely.md', 'still-lonely.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0 });
  });

  it('rewrites every variant ([[x]], ![[x]], [[x|alias]]) in one source', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'Plain [[target]], embed ![[target]], and alias [[target|see target]] done.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    // Three edges for clarity — rewriter doesn't actually use the count, only the set of source files.
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'embed' });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 1, occurrences: 3 });

    const src = await readFile(join(vault, 'source.md'), 'utf-8');
    expect(src).toBe(
      'Plain [[renamed]], embed ![[renamed]], and alias [[renamed|see target]] done.\n',
    );
  });

  it('rewrites links across multiple source files', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(join(vault, 'a.md'), 'Refs [[target]] here.\n', 'utf-8');
    await writeFile(join(vault, 'b.md'), 'And [[target#Intro]] there.\n', 'utf-8');

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'target.md', context: 'link' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 2, occurrences: 2 });

    expect(await readFile(join(vault, 'a.md'), 'utf-8')).toBe(
      'Refs [[renamed]] here.\n',
    );
    expect(await readFile(join(vault, 'b.md'), 'utf-8')).toBe(
      'And [[renamed#Intro]] there.\n',
    );
  });

  it('skips rewriting when only the directory changes (stem unchanged)', async () => {
    await writeFile(join(vault, 'keep.md'), '# keep\n', 'utf-8');
    await writeFile(join(vault, 'source.md'), 'Points at [[keep]].\n', 'utf-8');

    upsertNode(db, { id: 'keep.md', title: 'keep', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'keep.md', context: 'link' });

    // Move into a subdir, same basename.
    const move = await moveNote(vault, 'keep.md', 'Archive/keep.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0 });

    // Source file untouched — the bare stem still resolves.
    expect(await readFile(join(vault, 'source.md'), 'utf-8')).toBe(
      'Points at [[keep]].\n',
    );
  });

  it('tolerates source files that disappeared between edge-insert and rewrite', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    // Note: no file written for ghost.md — the edge store is stale.

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'ghost.md', title: 'Ghost', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'ghost.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    // Missing file is silently skipped; no throw, no false positive.
    expect(report).toEqual({ files: 0, occurrences: 0 });
  });
});

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
    // Seed stub nodes matching the old stem (_move_target).
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

    // Source note with an inbound edge pointing at the plain stub (simulating a
    // [[_move_target]] link that created the stub). After the move + link
    // rewrite the edge is gone (link was rewritten) so there are zero inbound
    // edges on both stubs — exactly what happens at prune time.
    upsertNode(db, {
      id: '_move_source.md',
      title: '_move_source',
      content: '[[_move_target#Section A]]',
      frontmatter: {},
    });
    // Do NOT insert any inbound edges — post-rewrite state: stubs are orphaned.

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
    // This source still links to the stub (its link was NOT rewritten).
    insertEdge(db, { sourceId: '_other_source.md', targetId: stubId, context: 'link' });

    const pruned = pruneOrphanStubs(db, [stubId]);
    expect(pruned).toBe(0);

    // Stub survives because it has an inbound edge.
    expect(allNodeIds(db)).toContain(stubId);
  });

  it('full move flow: rewrite then prune leaves no orphan stubs for old stem', async () => {
    // Disk setup.
    await writeFile(join(vault, '_move_target.md'), '# Move Target\n', 'utf-8');
    await writeFile(
      join(vault, '_move_source.md'),
      'See [[_move_target#Section A]] for context.\n',
      'utf-8',
    );

    // Graph setup: real notes + stubs as they would exist before the move.
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

    // Edge: source links to the section stub (representing [[_move_target#Section A]]).
    insertEdge(db, {
      sourceId: '_move_source.md',
      targetId: stubSection,
      context: 'link',
    });
    // Also an edge to the plain stub.
    insertEdge(db, {
      sourceId: '_move_source.md',
      targetId: stubPlain,
      context: 'link',
    });

    // Perform the move on disk.
    const moveResult = await moveNote(vault, '_move_target.md', '_move_target_renamed.md');

    // Rewrite inbound links in source files (this removes the [[_move_target…]]
    // occurrences and replaces them with [[_move_target_renamed…]]).
    await rewriteInboundLinks(db, vault, moveResult.oldPath, moveResult.newPath);

    // At this point the stubs still exist in the graph — the rewrite only
    // touched disk. Now simulate what the move tool does: remove edges from
    // _move_source.md to old stubs (they are now stale), then prune.
    // In the real tool the reindex would update edges; here we manually clear
    // the stale edges to mirror post-rewrite state.
    db.prepare('DELETE FROM edges WHERE source_id = ? AND target_id = ?').run(
      '_move_source.md',
      stubSection,
    );
    db.prepare('DELETE FROM edges WHERE source_id = ? AND target_id = ?').run(
      '_move_source.md',
      stubPlain,
    );

    // Now prune — this is what the tool does after rewriteInboundLinks returns.
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
