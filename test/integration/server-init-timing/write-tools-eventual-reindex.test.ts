/**
 * Integration tests for v1.6.7 init-timing behaviour — eventual consistency.
 *
 * Write tools queue a background reindex; the call is fire-and-forget. After
 * the embedder resolves, pipeline.index must eventually fire. Each test spies
 * on ctx.pipeline.index, issues the write while init is still in flight,
 * resolves init, and polls until the spy records a call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { IndexPipeline } from '../../../src/pipeline/indexer.js';

import { registerCreateNoteTool } from '../../../src/tools/create-note.js';
import { registerEditNoteTool } from '../../../src/tools/edit-note.js';
import { registerMoveNoteTool } from '../../../src/tools/move-note.js';
import { registerDeleteNoteTool } from '../../../src/tools/delete-note.js';
import { registerLinkNotesTool } from '../../../src/tools/link-notes.js';

import { makeMockServer } from '../../helpers/mock-server.js';
import { SlowMockEmbedder } from '../../helpers/mock-embedders.js';
import { buildCtx, seedEmbedder } from '../../helpers/init-timing-ctx.js';
import { spyIndexCalls, waitForIndexCall } from '../../helpers/reindex-spy.js';

describe.sequential('server-init-timing — write tools eventually reindex', () => {
  let vault: string;
  let db: DatabaseHandle;
  let seedPipeline: IndexPipeline;
  let mockEmbedder: SlowMockEmbedder;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'init-timing-write-evt-'));
    db = openDb(':memory:');
    mockEmbedder = new SlowMockEmbedder();
    seedPipeline = new IndexPipeline(db, seedEmbedder);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  it('create_note eventually calls pipeline.index after the embedder resolves', async () => {
    const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);
    const { indexCalls } = spyIndexCalls(ctx);

    const { server, registered } = makeMockServer();
    registerCreateNoteTool(server, ctx);
    const createTool = registered.find((t) => t.name === 'create_note')!;

    await createTool.cb({ title: 'EventualNote', content: 'async content' });
    expect(indexCalls).toHaveLength(0);

    setReady();
    await waitForIndexCall(indexCalls);

    expect(indexCalls.length).toBeGreaterThan(0);
    expect(indexCalls[0]).toBe(vault);
  }, 10_000);

  it('edit_note eventually calls pipeline.index after the embedder resolves', async () => {
    await writeFile(join(vault, 'EditLater.md'), '# EditLater\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);
    const { indexCalls } = spyIndexCalls(ctx);

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, ctx);
    const editTool = registered.find((t) => t.name === 'edit_note')!;

    await editTool.cb({ name: 'EditLater', mode: 'append', content: 'more text' });
    expect(indexCalls).toHaveLength(0);

    setReady();
    await waitForIndexCall(indexCalls);

    expect(indexCalls.length).toBeGreaterThan(0);
  }, 10_000);

  it('delete_note eventually calls pipeline.index after the embedder resolves', async () => {
    await writeFile(join(vault, 'DeleteLater.md'), '# DeleteLater\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);
    const { indexCalls } = spyIndexCalls(ctx);

    const { server, registered } = makeMockServer();
    registerDeleteNoteTool(server, ctx);
    const deleteTool = registered.find((t) => t.name === 'delete_note')!;

    await deleteTool.cb({ name: 'DeleteLater', confirm: true });
    expect(indexCalls).toHaveLength(0);

    setReady();
    await waitForIndexCall(indexCalls);

    expect(indexCalls.length).toBeGreaterThan(0);
  }, 10_000);

  it('move_note eventually calls pipeline.index after the embedder resolves', async () => {
    await writeFile(join(vault, 'MoveLater.md'), '# MoveLater\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);
    const { indexCalls } = spyIndexCalls(ctx);

    const { server, registered } = makeMockServer();
    registerMoveNoteTool(server, ctx);
    const moveTool = registered.find((t) => t.name === 'move_note')!;

    await moveTool.cb({ source: 'MoveLater', destination: 'MoveLaterRenamed' });
    expect(indexCalls).toHaveLength(0);

    setReady();
    await waitForIndexCall(indexCalls);

    expect(indexCalls.length).toBeGreaterThan(0);
  }, 10_000);

  it('link_notes eventually calls pipeline.index after the embedder resolves', async () => {
    await writeFile(join(vault, 'LinkA.md'), '# LinkA\n\nbody\n');
    await writeFile(join(vault, 'LinkB.md'), '# LinkB\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);
    const { indexCalls } = spyIndexCalls(ctx);

    const { server, registered } = makeMockServer();
    registerLinkNotesTool(server, ctx);
    const linkTool = registered.find((t) => t.name === 'link_notes')!;

    await linkTool.cb({ source: 'LinkA', target: 'LinkB', context: 'background link test' });
    expect(indexCalls).toHaveLength(0);

    setReady();
    await waitForIndexCall(indexCalls);

    expect(indexCalls.length).toBeGreaterThan(0);
  }, 10_000);
});
