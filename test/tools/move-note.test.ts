import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode, allNodeIds, pruneOrphanStubs } from '../../src/store/nodes.js';
import { insertEdge, getEdgesByTarget } from '../../src/store/edges.js';
import { moveNote } from '../../src/vault/mover.js';
import { rewriteInboundLinks, registerMoveNoteTool } from '../../src/tools/move-note.js';
import type { ServerContext } from '../../src/context.js';

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
    expect(report).toEqual({ files: 1, occurrences: 1, rewrittenSources: ['source.md'] });

    const src = await readFile(join(vault, 'source.md'), 'utf-8');
    expect(src).toBe('See [[renamed]] for context.\n');
  });

  it('reports zero when nothing links to the moved note', async () => {
    await writeFile(join(vault, 'lonely.md'), '# Lonely\n', 'utf-8');
    upsertNode(db, { id: 'lonely.md', title: 'Lonely', content: '', frontmatter: {} });

    const move = await moveNote(vault, 'lonely.md', 'still-lonely.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });
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
    expect(report).toEqual({ files: 1, occurrences: 3, rewrittenSources: ['source.md'] });

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
    expect(report.files).toBe(2);
    expect(report.occurrences).toBe(2);
    expect(new Set(report.rewrittenSources)).toEqual(new Set(['a.md', 'b.md']));

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
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });

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
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });
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

// ---------------------------------------------------------------------------
// Helpers shared by the dryRun describe block below.
// ---------------------------------------------------------------------------

interface RecordedTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (args: any) => Promise<any>;
}

function makeMockServer(): { server: any; registered: RecordedTool[] } {
  const registered: RecordedTool[] = [];
  const server = {
    tool(
      name: string,
      _d: string,
      _s: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (args: any) => Promise<any>,
    ): void {
      registered.push({ name, cb });
    },
  };
  return { server, registered };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: any): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

/**
 * dryRun=true on move_note must return a preview without touching disk or DB.
 */
describe('move_note dryRun=true returns preview without mutating (v1.6.0-C)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-move-dryrun-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  function buildCtx(): ServerContext {
    return {
      db,
      config: { vaultPath: vault },
      ensureEmbedderReady: async () => {},
      pipeline: { index: async () => undefined },
    } as unknown as ServerContext;
  }

  it('with dryRun=true returns preview without mutating', async () => {
    // Set up: target note + source note that links to it.
    await writeFile(join(vault, 'alpha.md'), '# Alpha\n', 'utf-8');
    await writeFile(join(vault, 'ref.md'), 'See [[alpha]] for details.\n', 'utf-8');

    upsertNode(db, { id: 'alpha.md', title: 'Alpha', content: '', frontmatter: {} });
    upsertNode(db, { id: 'ref.md', title: 'Ref', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'ref.md', targetId: 'alpha.md', context: 'link' });

    // Record before state.
    const beforeDisk = await readFile(join(vault, 'ref.md'), 'utf-8');
    const beforeNodes = allNodeIds(db).slice().sort();

    const { server, registered } = makeMockServer();
    registerMoveNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'move_note')!;

    const payload = unwrap(
      await tool.cb({ source: 'alpha.md', destination: 'beta', dryRun: true }),
    );

    // Preview fields are present.
    expect(payload.dryRun).toBe(true);
    expect(payload.oldPath).toBe('alpha.md');
    expect(payload.newPath).toBe('beta.md');
    expect(payload.totalFiles).toBe(1);
    expect(payload.totalOccurrences).toBe(1);
    expect(payload.linksToRewrite).toHaveLength(1);
    expect(payload.linksToRewrite[0].file).toBe('ref.md');
    expect(payload.linksToRewrite[0].occurrences).toBe(1);

    // Disk is unchanged — ref.md was NOT rewritten.
    const afterDisk = await readFile(join(vault, 'ref.md'), 'utf-8');
    expect(afterDisk).toBe(beforeDisk);

    // alpha.md was NOT renamed.
    await expect(readFile(join(vault, 'alpha.md'), 'utf-8')).resolves.toBeDefined();

    // DB is unchanged.
    const afterNodes = allNodeIds(db).slice().sort();
    expect(afterNodes).toEqual(beforeNodes);
  });
});

/**
 * Regression tests for v1.6.2 — `move_note` ghost-link fix.
 *
 * The field symptom: user renames BMW.md → `BMW & Audi.md`, but `Cars.md`
 * (which contained `[[BMW]]`) ends up unchanged on disk, and the graph shows
 * a dangling edge Cars → _stub/BMW.md. Two root causes:
 *
 *  (a) `rewriteInboundLinks` queried `getEdgesByTarget(db, oldPath)` only,
 *      so inbound edges still targeting `_stub/${oldStem}.md` (leftovers
 *      from forward-ref timing or pre-v1.5.8 state) were silently skipped
 *      and the source files never got rewritten.
 *
 *  (b) `indexSingleNote` — the watcher's per-file path — didn't call
 *      `migrateStubToReal` when a real note arrived with a pre-existing
 *      forward-ref stub. So stub-target edges persisted indefinitely.
 *
 * The fix merges `_stub/${oldStem}.md` into the inbound-edge lookup and
 * wires `indexSingleNote` to migrate forward-stubs the same way
 * `create_note` does.
 */
describe('move_note ghost-link fix (v1.6.2)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-v1-6-2-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('rewriteInboundLinks finds source files whose edge targets _stub/<oldStem>.md', async () => {
    // Disk state: both files exist, BMW is the real target.
    await writeFile(join(vault, 'BMW.md'), '# BMW\n', 'utf-8');
    await writeFile(join(vault, 'Cars.md'), 'I drive a [[BMW]] every day.\n', 'utf-8');

    // Graph state: mimic pre-v1.5.8 — the real BMW node exists, but Cars's
    // edge still points at _stub/BMW.md because the forward-ref migration
    // never ran. The ghost-link symptom starts here.
    upsertNode(db, { id: 'BMW.md', title: 'BMW', content: '', frontmatter: {} });
    upsertNode(db, { id: 'Cars.md', title: 'Cars', content: '', frontmatter: {} });
    upsertNode(db, {
      id: '_stub/BMW.md',
      title: 'BMW',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'Cars.md', targetId: '_stub/BMW.md', context: 'link' });

    // Rename BMW → "BMW & Audi".
    const move = await moveNote(vault, 'BMW.md', 'BMW & Audi.md');

    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);

    // The stub-target edge must now pull Cars.md into the rewrite set.
    expect(report.files).toBe(1);
    expect(report.occurrences).toBe(1);
    expect(report.rewrittenSources).toEqual(['Cars.md']);

    // And the file content on disk is updated.
    expect(await readFile(join(vault, 'Cars.md'), 'utf-8')).toBe(
      'I drive a [[BMW & Audi]] every day.\n',
    );
  });

  it('combines real-target and stub-target inbound edges without double-counting the same source', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'Real-target [[target]] and stub-target [[target]] again.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    // Two edges: one resolved to the real node, one stuck on the stub.
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });
    upsertNode(db, {
      id: '_stub/target.md',
      title: 'target',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'source.md', targetId: '_stub/target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);

    // The source is rewritten once (Set dedup), occurrences counts both hits.
    expect(report.files).toBe(1);
    expect(report.occurrences).toBe(2);
    expect(report.rewrittenSources).toEqual(['source.md']);
  });
});

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
    // Vault: real target + two source files pointing at it.
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(join(vault, 'a.md'), 'See [[target]] today.\n', 'utf-8');
    await writeFile(join(vault, 'b.md'), 'Reference to [[target]].\n', 'utf-8');

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'target.md', context: 'see' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'target.md', context: 'ref' });

    // Step 1: disk move.
    const moved = await moveNote(vault, 'target.md', 'renamed.md');

    // Step 2: rewrite source files on disk BEFORE touching the DB. This
    // mirrors the move_note handler ordering — the rewrite queries edges
    // keyed on the old path, so renameNode must run AFTER.
    await rewriteInboundLinks(db, vault, moved.oldPath, moved.newPath);

    // Step 3: atomic DB rename — inbound edges repoint.
    const { renameNode } = await import('../../src/store/rename.js');
    renameNode(db, moved.oldPath, moved.newPath);

    // Inbound edges must now point at the new id with zero gap.
    const stillOnOld = getEdgesByTarget(db, 'target.md');
    const onNew = getEdgesByTarget(db, 'renamed.md');
    expect(stillOnOld).toHaveLength(0);
    expect(onNew).toHaveLength(2);
    expect(new Set(onNew.map((e) => e.sourceId))).toEqual(new Set(['a.md', 'b.md']));
    expect(new Set(onNew.map((e) => e.context))).toEqual(new Set(['see', 'ref']));

    // Disk is correctly rewritten too.
    expect(await readFile(join(vault, 'a.md'), 'utf-8')).toBe('See [[renamed]] today.\n');
    expect(await readFile(join(vault, 'b.md'), 'utf-8')).toBe('Reference to [[renamed]].\n');
  });
});
