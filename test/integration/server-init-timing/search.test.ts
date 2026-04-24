/**
 * Integration tests for v1.6.7 init-timing behaviour — search paths only.
 *
 *   - search({mode:'semantic'|'hybrid'}) returns {status:'preparing'} while
 *     the embedder init is still in flight.
 *   - search({mode:'semantic'|'hybrid'}) returns {status:'failed'} when the
 *     embedder init threw.
 *   - search({mode:'fulltext'}) works at any time — no embedder needed.
 *
 * Uses SlowMockEmbedder with a hand-resolved init promise to deterministically
 * exercise the init-in-flight window without any real model download.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { IndexPipeline } from '../../../src/pipeline/indexer.js';
import { registerSearchTool } from '../../../src/tools/search.js';

import { makeMockServer, unwrap } from '../../helpers/mock-server.js';
import { SlowMockEmbedder } from '../../helpers/mock-embedders.js';
import { buildCtx, seedEmbedder } from '../../helpers/init-timing-ctx.js';

describe.sequential('server-init-timing — search', () => {
  let vault: string;
  let db: DatabaseHandle;
  let seedPipeline: IndexPipeline;
  let mockEmbedder: SlowMockEmbedder;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'init-timing-search-'));
    db = openDb(':memory:');
    mockEmbedder = new SlowMockEmbedder();
    seedPipeline = new IndexPipeline(db, seedEmbedder);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  describe('semantic mode — embedder not ready', () => {
    it("returns {status:'preparing'} immediately while init is in flight", async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);
      void ctx.ensureEmbedderReady().catch(() => undefined);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;
      expect(searchTool).toBeDefined();

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'semantic' }));

      expect(result.status).toBe('preparing');
      expect(typeof result.message).toBe('string');
      expect(result.message.toLowerCase()).toMatch(/download|preparing/);
    });

    it("returns 'downloading' message when reindexInProgress is false + embedder not ready", async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);
      // reindexInProgress defaults to false
      expect(ctx.reindexInProgress).toBe(false);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'semantic' }));

      expect(result.status).toBe('preparing');
      expect(result.message).toMatch(/downloading/i);
    });

    it("returns 're-embedding' message when reindexInProgress is true + embedder not ready", async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);
      ctx.reindexInProgress = true;

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'semantic' }));

      expect(result.status).toBe('preparing');
      expect(result.message).toMatch(/re-embedding/i);
    });

    it("returns {status:'preparing'} for hybrid mode too", async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'hybrid' }));

      expect(result.status).toBe('preparing');
    });

    it("returns {status:'preparing'} for default (no mode specified)", async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything' }));

      expect(result.status).toBe('preparing');
    });
  });

  describe('semantic mode — embedder init failed', () => {
    it("returns {status:'failed'} when init threw", async () => {
      const { ctx, setFailed } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const initP = ctx.ensureEmbedderReady().catch(() => undefined);
      setFailed(new Error('network error: ENOTFOUND'));
      await initP;

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'semantic' }));

      expect(result.status).toBe('failed');
      expect(typeof result.message).toBe('string');
      expect(result.message.toLowerCase()).toMatch(/failed to load|restart/i);
    });

    it('failed status also covers hybrid mode', async () => {
      const { ctx, setFailed } = buildCtx(vault, db, seedPipeline, mockEmbedder);
      const initP = ctx.ensureEmbedderReady().catch(() => undefined);
      setFailed(new Error('model file corrupted'));
      await initP;

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'hybrid' }));
      expect(result.status).toBe('failed');
    });
  });

  describe('fulltext mode — no embedder required', () => {
    it('returns results without waiting for the embedder', async () => {
      await writeFile(join(vault, 'Cars.md'), '# Cars\n\nI drive a fast car.\n');
      await seedPipeline.index(vault);

      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const start = Date.now();
      const result = unwrap(await searchTool.cb({ query: 'car', mode: 'fulltext' }));
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(result).toHaveProperty('data');
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('does not return a status field (no preparing/failed)', async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'fulltext' }));

      expect(result.status).toBeUndefined();
    });

    it('ignores reindexInProgress — fulltext is always unblocked', async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);
      // Even with reindexInProgress = true, fulltext should never return preparing/failed
      ctx.reindexInProgress = true;

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'fulltext' }));

      // fulltext bypasses the embedder guard entirely
      expect(result.status).toBeUndefined();
    });
  });
});
