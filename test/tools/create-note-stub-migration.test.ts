/**
 * Single-note stub migration (create_note + watcher add) must migrate the
 * same stubs the full index pass would: different-case (`[[newnote]]`) and
 * path-qualified (`[[projects/newnote]]`) forward references, not only the
 * exact `_stub/<Stem>.md`.
 *
 * create_note's background reindex waits on a SlowMockEmbedder that never
 * becomes ready, so every assertion here observes the synchronous migration
 * create_note performs before it returns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getNode } from '../../src/store/nodes.js';
import { getEdgesBySource } from '../../src/store/edges.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { registerCreateNoteTool } from '../../src/tools/create-note.js';
import { makeMockServer, unwrap } from '../helpers/mock-server.js';
import { SlowMockEmbedder } from '../helpers/mock-embedders.js';
import { buildCtx, seedEmbedder } from '../helpers/init-timing-ctx.js';

describe('single-note stub migration', () => {
  let vault: string;
  let db: DatabaseHandle;
  let pipeline: IndexPipeline;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'stub-migrate-'));
    db = openDb(':memory:');
    pipeline = new IndexPipeline(db, seedEmbedder);
    await writeFile(
      join(vault, 'Src.md'),
      '# Src\n\nLower-case [[newnote]] and path-qualified [[projects/newnote]] and [[Unrelated]].\n',
    );
    await pipeline.index(vault);
    expect(getNode(db, '_stub/newnote.md')).toBeDefined();
    expect(getNode(db, '_stub/projects/newnote.md')).toBeDefined();
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  const targets = (): string[] => getEdgesBySource(db, 'Src.md').map((e) => e.targetId).sort();

  it('create_note migrates different-case and path-qualified stubs before returning', async () => {
    const { ctx } = buildCtx(vault, db, pipeline, new SlowMockEmbedder());
    const { server, registered } = makeMockServer();
    registerCreateNoteTool(server, ctx);
    const tool = registered.find((t) => t.name === 'create_note')!;

    const result = unwrap(await tool.cb({ title: 'NewNote', content: 'body', directory: 'Projects' }));
    expect(result.path).toBe('Projects/NewNote.md');

    expect(getNode(db, '_stub/newnote.md')).toBeUndefined();
    expect(getNode(db, '_stub/projects/newnote.md')).toBeUndefined();
    expect(getNode(db, '_stub/Unrelated.md')).toBeDefined();
    expect(targets()).toEqual(['Projects/NewNote.md', 'Projects/NewNote.md', '_stub/Unrelated.md']);
  });

  it('watcher add (indexSingleNote) migrates different-case and path-qualified stubs', async () => {
    await mkdir(join(vault, 'Projects'));
    await writeFile(join(vault, 'Projects', 'NewNote.md'), '# NewNote\n\nArrived via the watcher.\n');
    await pipeline.indexSingleNote(vault, 'Projects/NewNote.md', 'add');

    expect(getNode(db, '_stub/newnote.md')).toBeUndefined();
    expect(getNode(db, '_stub/projects/newnote.md')).toBeUndefined();
    expect(getNode(db, '_stub/Unrelated.md')).toBeDefined();
    expect(targets()).toEqual(['Projects/NewNote.md', 'Projects/NewNote.md', '_stub/Unrelated.md']);
  });
});
