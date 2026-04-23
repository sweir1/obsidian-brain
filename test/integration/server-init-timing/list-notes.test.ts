/**
 * Integration test for v1.6.7 init-timing behaviour — list_notes.
 *
 * list_notes has no embedder dependency and must return immediately while
 * the embedder is still initialising.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { IndexPipeline } from '../../../src/pipeline/indexer.js';
import { registerListNotesTool } from '../../../src/tools/list-notes.js';

import { makeMockServer, unwrap } from '../../helpers/mock-server.js';
import { SlowMockEmbedder } from '../../helpers/mock-embedders.js';
import { buildCtx, seedEmbedder } from '../../helpers/init-timing-ctx.js';

describe.sequential('server-init-timing — list_notes', () => {
  let vault: string;
  let db: DatabaseHandle;
  let seedPipeline: IndexPipeline;
  let mockEmbedder: SlowMockEmbedder;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'init-timing-list-'));
    db = openDb(':memory:');
    mockEmbedder = new SlowMockEmbedder();
    seedPipeline = new IndexPipeline(db, seedEmbedder);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  it('returns results immediately while embedder is still initialising', async () => {
    await writeFile(join(vault, 'Alpha.md'), '# Alpha\n\nbody\n');
    await seedPipeline.index(vault);

    const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

    const { server, registered } = makeMockServer();
    registerListNotesTool(server, ctx);
    const listTool = registered.find((t) => t.name === 'list_notes')!;
    expect(listTool).toBeDefined();

    const start = Date.now();
    const result = unwrap(await listTool.cb({}));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(Array.isArray(result)).toBe(true);
    expect(result.some((n: { id: string }) => n.id === 'Alpha.md')).toBe(true);
  });
});
