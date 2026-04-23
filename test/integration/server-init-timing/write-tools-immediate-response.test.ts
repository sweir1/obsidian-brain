/**
 * Integration tests for v1.6.7 init-timing behaviour — write tool responsiveness.
 *
 * Every write tool (create_note / edit_note / delete_note / move_note /
 * link_notes) must return in <500ms even while the embedder is still
 * initialising. The actual reindex fires in the background — see
 * write-tools-eventual-reindex.test.ts for that half.
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

import { makeMockServer, unwrap } from '../../helpers/mock-server.js';
import { SlowMockEmbedder } from '../../helpers/mock-embedders.js';
import { buildCtx, seedEmbedder } from '../../helpers/init-timing-ctx.js';

describe.sequential('server-init-timing — write tools return in <500ms', () => {
  let vault: string;
  let db: DatabaseHandle;
  let seedPipeline: IndexPipeline;
  let mockEmbedder: SlowMockEmbedder;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'init-timing-write-imm-'));
    db = openDb(':memory:');
    mockEmbedder = new SlowMockEmbedder();
    seedPipeline = new IndexPipeline(db, seedEmbedder);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  it('create_note returns the new note path in <500ms', async () => {
    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerCreateNoteTool(server, ctx);
    const createTool = registered.find((t) => t.name === 'create_note')!;

    const start = Date.now();
    const result = unwrap(await createTool.cb({ title: 'MyNote', content: 'hello world' }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.path).toBe('MyNote.md');
  });

  it('edit_note returns in <500ms', async () => {
    await writeFile(join(vault, 'EditMe.md'), '# EditMe\n\noriginal body\n');
    await seedPipeline.index(vault);

    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, ctx);
    const editTool = registered.find((t) => t.name === 'edit_note')!;

    const start = Date.now();
    const result = unwrap(await editTool.cb({
      name: 'EditMe',
      mode: 'append',
      content: 'appended line',
    }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // edit_note returns the vault-relative path (may include subdir on some impls).
    expect(result.path).toMatch(/EditMe\.md$/);
  });

  it('delete_note returns in <500ms', async () => {
    await writeFile(join(vault, 'DeleteMe.md'), '# DeleteMe\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerDeleteNoteTool(server, ctx);
    const deleteTool = registered.find((t) => t.name === 'delete_note')!;

    const start = Date.now();
    const result = unwrap(await deleteTool.cb({ name: 'DeleteMe', confirm: true }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // May be bare payload or wrapped in a next_actions envelope.
    const payload = 'data' in result ? result.data : result;
    expect(payload.deletedFromIndex).toBeDefined();
  });

  it('move_note returns in <500ms', async () => {
    await writeFile(join(vault, 'MoveMe.md'), '# MoveMe\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerMoveNoteTool(server, ctx);
    const moveTool = registered.find((t) => t.name === 'move_note')!;

    const start = Date.now();
    const result = unwrap(await moveTool.cb({ source: 'MoveMe', destination: 'MovedNote' }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.newPath).toBe('MovedNote.md');
  });

  it('link_notes returns in <500ms', async () => {
    await writeFile(join(vault, 'LinkSrc.md'), '# LinkSrc\n\nbody\n');
    await writeFile(join(vault, 'LinkTgt.md'), '# LinkTgt\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerLinkNotesTool(server, ctx);
    const linkTool = registered.find((t) => t.name === 'link_notes')!;

    const start = Date.now();
    const result = unwrap(await linkTool.cb({
      source: 'LinkSrc',
      target: 'LinkTgt',
      context: 'relates to',
    }));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.source).toBe('LinkSrc.md');
  });
});
