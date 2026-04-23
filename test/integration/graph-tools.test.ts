/**
 * End-to-end integration tests for every MCP tool that mutates the
 * knowledge graph. Each test drives the real tool handler through a real
 * `IndexPipeline.index()` cycle and asserts final graph state (especially
 * inbound edges) afterwards.
 *
 * Why this file exists: the v1.6.2 → v1.6.5 bugs were all invisible to
 * unit tests. They lived in the *interactions* between primitives
 * (rewrite ↔ reindex ↔ deletion-detection ↔ stub-migration) and in
 * *messy preconditions* (stub-target edges, forward-refs) that unit
 * tests never constructed. Every graph-touching tool earns at least one
 * integration test here.
 *
 * A single shared embedder amortises the model load across every test.
 * `describe.sequential` keeps tests from racing for the vault directory.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { Embedder } from '../../src/embeddings/embedder.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { getNode } from '../../src/store/nodes.js';
import {
  getEdgesByTarget,
  getEdgesBySource,
  countEdgesByTarget,
} from '../../src/store/edges.js';

import { registerCreateNoteTool } from '../../src/tools/create-note.js';
import { registerEditNoteTool } from '../../src/tools/edit-note.js';
import { registerApplyEditPreviewTool } from '../../src/tools/apply-edit-preview.js';
import { registerLinkNotesTool } from '../../src/tools/link-notes.js';
import { registerMoveNoteTool } from '../../src/tools/move-note.js';
import { registerDeleteNoteTool } from '../../src/tools/delete-note.js';
import { registerReindexTool } from '../../src/tools/reindex.js';

import type { ServerContext } from '../../src/context.js';
import { makeMockServer, unwrap } from '../helpers/mock-server.js';
import { buildSimpleCtx, cleanupCtx } from '../helpers/graph-ctx.js';

describe.sequential('graph-tools integration (pipeline.index + inbound-edge assertions)', () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = new Embedder();
    await embedder.init();
  }, 120_000);

  afterAll(async () => {
    await embedder.dispose();
  });

  let vault: string;
  let db: DatabaseHandle;
  let pipeline: IndexPipeline;
  let ctx: ServerContext;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-integration-'));
    db = openDb(':memory:');
    pipeline = new IndexPipeline(db, embedder);
    ctx = buildSimpleCtx(vault, db, pipeline, embedder);
  });

  describe('create_note', () => {
    it('resolves forward-reference stubs when the new real note arrives', async () => {
      // Seed: Cars.md exists with a forward-ref to a note that does not
      // yet exist on disk. Running the indexer materialises a stub.
      await writeFile(join(vault, 'Cars.md'), '# Cars\n\nI drive a [[BMW]].\n');
      await pipeline.index(vault);

      expect(getNode(db, '_stub/BMW.md')).toBeDefined();
      const preEdges = getEdgesBySource(db, 'Cars.md');
      expect(preEdges.some((e) => e.targetId === '_stub/BMW.md')).toBe(true);

      const { server, registered } = makeMockServer();
      registerCreateNoteTool(server, ctx);
      const tool = registered.find((t) => t.name === 'create_note')!;
      const result = unwrap(await tool.cb({ title: 'BMW', content: 'The car.' }));

      expect(result.path).toBe('BMW.md');

      // After create_note's reindex + forward-stub migration: stub is
      // gone, inbound edge from Cars now targets the real BMW.md.
      expect(getNode(db, '_stub/BMW.md')).toBeUndefined();
      expect(getNode(db, 'BMW.md')).toBeDefined();
      const inbound = getEdgesByTarget(db, 'BMW.md');
      expect(inbound.some((e) => e.sourceId === 'Cars.md')).toBe(true);

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('edit_note', () => {
    it('appending a wiki-link creates the outbound edge after the reindex', async () => {
      await writeFile(join(vault, 'Cars.md'), '# Cars\n\nNo links yet.\n');
      await writeFile(join(vault, 'BMW.md'), '# BMW\n\nThe car.\n');
      await pipeline.index(vault);

      expect(getEdgesByTarget(db, 'BMW.md')).toHaveLength(0);

      const { server, registered } = makeMockServer();
      registerEditNoteTool(server, ctx);
      const tool = registered.find((t) => t.name === 'edit_note')!;
      await tool.cb({
        name: 'Cars',
        mode: 'append',
        content: 'See [[BMW]] for details.',
      });

      // edit_note fires the reindex in the background (fire-and-forget).
      // Force it to completion to verify eventual consistency.
      await pipeline.index(vault);

      const inbound = getEdgesByTarget(db, 'BMW.md');
      expect(inbound.some((e) => e.sourceId === 'Cars.md')).toBe(true);

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('apply_edit_preview', () => {
    it('committing a dryRun preview updates the graph inbound edges', async () => {
      await writeFile(join(vault, 'Notes.md'), '# Notes\n\nEmpty body.\n');
      await writeFile(join(vault, 'Target.md'), '# Target\n\nExists.\n');
      await pipeline.index(vault);

      expect(getEdgesByTarget(db, 'Target.md')).toHaveLength(0);

      const { server, registered } = makeMockServer();
      registerEditNoteTool(server, ctx);
      registerApplyEditPreviewTool(server, ctx);

      const editTool = registered.find((t) => t.name === 'edit_note')!;
      const preview = unwrap(await editTool.cb({
        name: 'Notes',
        mode: 'append',
        content: 'Now links to [[Target]].',
        dryRun: true,
      }));
      expect(preview.dryRun).toBe(true);
      expect(preview.previewId).toBeTruthy();

      const applyTool = registered.find((t) => t.name === 'apply_edit_preview')!;
      const applied = unwrap(await applyTool.cb({ previewId: preview.previewId }));
      expect(applied.path).toBe('Notes.md');

      await pipeline.index(vault);

      const inbound = getEdgesByTarget(db, 'Target.md');
      expect(inbound.some((e) => e.sourceId === 'Notes.md')).toBe(true);

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('link_notes', () => {
    it('creates an edge from source to target after the internal reindex', async () => {
      await writeFile(join(vault, 'A.md'), '# A\n\nbody\n');
      await writeFile(join(vault, 'B.md'), '# B\n\nbody\n');
      await pipeline.index(vault);

      expect(getEdgesByTarget(db, 'B.md')).toHaveLength(0);

      const { server, registered } = makeMockServer();
      registerLinkNotesTool(server, ctx);
      const tool = registered.find((t) => t.name === 'link_notes')!;
      await tool.cb({ source: 'A', target: 'B', context: 'relates to' });

      const inbound = getEdgesByTarget(db, 'B.md');
      expect(inbound.some((e) => e.sourceId === 'A.md')).toBe(true);

      const aContent = await readFile(join(vault, 'A.md'), 'utf-8');
      expect(aContent).toMatch(/\[\[B\]\]/);

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('move_note', () => {
    it('rename preserves inbound edges through the full handler + reindex', async () => {
      await writeFile(join(vault, 'Target.md'), '# Target\n\nhello\n');
      await writeFile(join(vault, 'A.md'), '# A\n\nSee [[Target]].\n');
      await writeFile(join(vault, 'B.md'), '# B\n\nAlso [[Target]].\n');
      await pipeline.index(vault);

      expect(getEdgesByTarget(db, 'Target.md')).toHaveLength(2);

      const { server, registered } = makeMockServer();
      registerMoveNoteTool(server, ctx);
      const tool = registered.find((t) => t.name === 'move_note')!;
      await tool.cb({ source: 'Target', destination: 'Renamed & Archived' });

      // Old target has zero inbound; new target has two, both pointing
      // at the new id directly (not at a stub).
      expect(getEdgesByTarget(db, 'Target.md')).toHaveLength(0);
      const inbound = getEdgesByTarget(db, 'Renamed & Archived.md');
      expect(inbound).toHaveLength(2);
      expect(new Set(inbound.map((e) => e.sourceId))).toEqual(new Set(['A.md', 'B.md']));

      const aContent = await readFile(join(vault, 'A.md'), 'utf-8');
      const bContent = await readFile(join(vault, 'B.md'), 'utf-8');
      expect(aContent).toContain('[[Renamed & Archived]]');
      expect(bContent).toContain('[[Renamed & Archived]]');

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('delete_note', () => {
    it('removes the node AND all of its inbound edges from sources that linked to it', async () => {
      await writeFile(join(vault, 'Target.md'), '# Target\n\nbody\n');
      await writeFile(join(vault, 'A.md'), '# A\n\nSee [[Target]].\n');
      await pipeline.index(vault);

      expect(countEdgesByTarget(db, 'Target.md')).toBe(1);

      const { server, registered } = makeMockServer();
      registerDeleteNoteTool(server, ctx);
      const tool = registered.find((t) => t.name === 'delete_note')!;
      const result = unwrap(await tool.cb({ name: 'Target', confirm: true }));

      // delete_note may wrap in a next_actions envelope when it drops
      // inbound edges. Unwrap defensively.
      const payload = 'data' in result ? result.data : result;
      expect(payload.deletedFromIndex).toBeDefined();

      expect(getNode(db, 'Target.md')).toBeUndefined();
      expect(countEdgesByTarget(db, 'Target.md')).toBe(0);

      // A.md's outbound link now resolves to a stub (the link text on disk
      // still says [[Target]], so the reparse creates _stub/Target.md).
      // Important: A.md itself is NOT orphaned or corrupted.
      expect(getNode(db, 'A.md')).toBeDefined();

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });

  describe('reindex', () => {
    it('prunes orphan stubs + reports stubsPruned in the response', async () => {
      await writeFile(join(vault, 'A.md'), '# A\n\nSee [[Ghost]].\n');
      await pipeline.index(vault);

      expect(getNode(db, '_stub/Ghost.md')).toBeDefined();
      expect(countEdgesByTarget(db, '_stub/Ghost.md')).toBe(1);

      // Rewrite A.md to drop its link. The ghost stub should now be
      // orphaned and swept on the next reindex.
      await writeFile(join(vault, 'A.md'), '# A\n\nNo more links.\n');

      const { server, registered } = makeMockServer();
      registerReindexTool(server, ctx);
      const tool = registered.find((t) => t.name === 'reindex')!;
      const result = unwrap(await tool.cb({}));

      expect(typeof result.stubsPruned).toBe('number');
      expect(getNode(db, '_stub/Ghost.md')).toBeUndefined();

      await cleanupCtx(ctx, vault, db);
    }, 120_000);
  });
});
