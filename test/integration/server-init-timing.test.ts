/**
 * Integration tests for v1.6.7 init-timing behaviour.
 *
 * Verifies that the server architecture introduced in v1.6.7 correctly
 * decouples the embedder init lifecycle from tool responsiveness:
 *
 *   - search({mode:'semantic'|'hybrid'}) returns {status:'preparing'} when the
 *     embedder init is still in flight.
 *   - search({mode:'semantic'|'hybrid'}) returns {status:'failed'} when the
 *     embedder init threw.
 *   - search({mode:'fulltext'}) works at any time — no embedder needed.
 *   - Write tools (create_note, edit_note, move_note, delete_note, link_notes)
 *     return immediately; the background reindex fires asynchronously.
 *     `pipeline.index()` is eventually called even though the tool already
 *     returned.
 *
 * We use a `SlowMockEmbedder` with a hand-resolved init promise so we can
 * deterministically exercise the "init in flight" window without downloading
 * any real models.
 *
 * Seed pipeline calls (done before each test to pre-populate the DB) use a
 * separate `InstantMockEmbedder` whose init resolves immediately and whose
 * embed() returns a zero-filled Float32Array — no real model download needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { VaultWriter } from '../../src/vault/writer.js';
import { Search } from '../../src/search/unified.js';

import { registerSearchTool } from '../../src/tools/search.js';
import { registerCreateNoteTool } from '../../src/tools/create-note.js';
import { registerEditNoteTool } from '../../src/tools/edit-note.js';
import { registerMoveNoteTool } from '../../src/tools/move-note.js';
import { registerDeleteNoteTool } from '../../src/tools/delete-note.js';
import { registerLinkNotesTool } from '../../src/tools/link-notes.js';
import { registerListNotesTool } from '../../src/tools/list-notes.js';

import type { ServerContext } from '../../src/context.js';
import type { Embedder } from '../../src/embeddings/types.js';

// ---------------------------------------------------------------------------
// InstantMockEmbedder — init resolves immediately, embed returns zero vector.
// Used by the "seed" pipeline.index() calls that happen BEFORE the test
// proper so we don't need the real model download just to populate nodes/edges.
// ---------------------------------------------------------------------------

class InstantMockEmbedder implements Embedder {
  async init(): Promise<void> {}

  async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    return new Float32Array(384);
  }

  dimensions(): number {
    return 384;
  }

  modelIdentifier(): string {
    return 'mock/instant';
  }

  providerName(): string {
    return 'mock';
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// SlowMockEmbedder — controllable init promise, no network I/O.
// init() returns a promise you resolve or reject on demand. embed() throws
// loudly if called (it shouldn't be needed in these timing tests).
// ---------------------------------------------------------------------------

class SlowMockEmbedder implements Embedder {
  private _resolve!: () => void;
  private _reject!: (err: unknown) => void;
  private _promise: Promise<void>;

  constructor() {
    this._promise = new Promise<void>((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
  }

  /** Resolve the pending init — simulates successful model download. */
  resolveInit(): void {
    this._resolve();
  }

  /** Reject the pending init — simulates a download failure. */
  rejectInit(err: unknown): void {
    this._reject(err);
  }

  async init(): Promise<void> {
    await this._promise;
  }

  async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    throw new Error(
      'SlowMockEmbedder.embed() should not be called — embedder not expected to run in init-timing tests',
    );
  }

  dimensions(): number {
    return 384;
  }

  modelIdentifier(): string {
    return 'mock/slow-embedder';
  }

  providerName(): string {
    return 'mock';
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Mock server helper — mirrors the pattern in graph-tools.test.ts.
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

/** Unwrap MCP content envelope. Throws if isError is set. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: any): any {
  if (result.isError) {
    const text = result.content?.[0]?.text ?? '(no text)';
    throw new Error(`Tool returned isError=true: ${text}`);
  }
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Context builder — uses a SlowMockEmbedder with manually-driven init state.
//
// embedderReady and initError are tracked in plain mutable variables and
// exposed as plain function / value properties (not getters) so the ctx
// object behaves identically to what ServerContext consumers expect.
// ---------------------------------------------------------------------------

interface CtxHandle {
  ctx: ServerContext;
  /** Resolve the mock embedder init — simulates successful model download. */
  setReady: () => void;
  /** Reject the mock embedder init — simulates download failure. */
  setFailed: (err: unknown) => void;
}

function buildCtx(
  vault: string,
  db: DatabaseHandle,
  pipeline: IndexPipeline,
  mockEmbedder: SlowMockEmbedder,
): CtxHandle {
  const writer = new VaultWriter(vault, db);
  const search = new Search(db, mockEmbedder);

  let embedderInitialized = false;
  let initError: unknown = undefined;

  // Cache the init promise so re-entrant callers share one model load.
  let initPromise: Promise<void> | null = null;

  const ensureEmbedderReady = (): Promise<void> => {
    if (!initPromise) {
      initPromise = mockEmbedder.init().then(() => {
        embedderInitialized = true;
      }).catch((err) => {
        initError = err;
        throw err;
      });
    }
    return initPromise;
  };

  // Build the ctx with embedderReady and initError as plain function / value.
  // We use a Proxy-like pattern: capture the mutable bindings in closures so
  // the ctx object always reflects the current state of the local vars.
  const ctx = {
    db,
    embedder: mockEmbedder,
    search,
    writer,
    pipeline,
    config: { vaultPath: vault, dataDir: vault, dbPath: ':memory:' },
    obsidian: null as unknown as ServerContext['obsidian'],
    ensureEmbedderReady,
    getBootstrap: () => null,
    // embedderReady and initError MUST be plain functions / accessors, not
    // getters on a literal object, because `as unknown as ServerContext` strips
    // getter descriptors. We use a function for embedderReady (matches the
    // ServerContext interface) and a plain property for initError (updated by
    // the ensureEmbedderReady chain via the closure).
    embedderReady: () => embedderInitialized,
    get initError() { return initError; },
  } as unknown as ServerContext;

  const setReady = (): void => {
    mockEmbedder.resolveInit();
  };

  const setFailed = (err: unknown): void => {
    mockEmbedder.rejectInit(err);
  };

  return { ctx, setReady, setFailed };
}

// ---------------------------------------------------------------------------
// Shared "seed" embedder — one instance per test suite, init is instant.
// The seed pipeline uses this for the beforeEach vault population so we
// never block on a real model download just to create fixture nodes.
// ---------------------------------------------------------------------------
const seedEmbedder = new InstantMockEmbedder();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.sequential('server-init-timing (v1.6.7 architecture)', () => {
  let vault: string;
  let db: DatabaseHandle;
  /** Seed pipeline — uses InstantMockEmbedder; only used for vault population. */
  let seedPipeline: IndexPipeline;
  let mockEmbedder: SlowMockEmbedder;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'init-timing-'));
    db = openDb(':memory:');
    mockEmbedder = new SlowMockEmbedder();
    // The seed pipeline talks to the same DB but uses the instant embedder so
    // beforeEach population does not hang on the slow-mock's init promise.
    seedPipeline = new IndexPipeline(db, seedEmbedder);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    db.close();
  });

  // -------------------------------------------------------------------------
  // #2 — search({mode:'semantic'}) returns status:'preparing' during init
  // -------------------------------------------------------------------------

  describe('search with semantic mode — embedder not ready', () => {
    it("returns {status:'preparing'} immediately while init is in flight", async () => {
      // DO NOT resolve the mock embedder — leave init in flight.
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      // Kick off ensureEmbedderReady in background (simulates server startup).
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

      // Default mode is 'hybrid', which needs the embedder.
      const result = unwrap(await searchTool.cb({ query: 'anything' }));

      expect(result.status).toBe('preparing');
    });
  });

  // -------------------------------------------------------------------------
  // #3 — search({mode:'semantic'}) returns status:'failed' when init errored
  // -------------------------------------------------------------------------

  describe('search with semantic mode — embedder init failed', () => {
    it("returns {status:'failed'} when init threw", async () => {
      const { ctx, setFailed } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      // Start the background init (mirrors server.ts startup kick-off).
      const initP = ctx.ensureEmbedderReady().catch(() => undefined);

      // Reject the embedder init to simulate download failure.
      setFailed(new Error('network error: ENOTFOUND'));

      // Wait for the rejection to propagate to ctx.initError via the closure.
      await initP;

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'semantic' }));

      expect(result.status).toBe('failed');
      expect(typeof result.message).toBe('string');
      expect(result.message.toLowerCase()).toMatch(/failed to load|restart/i);
    });

    it("failed status also covers hybrid mode", async () => {
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

  // -------------------------------------------------------------------------
  // #4 — search({mode:'fulltext'}) works while embedder is still initialising
  // -------------------------------------------------------------------------

  describe('search with fulltext mode — no embedder required', () => {
    it('returns results without waiting for the embedder', async () => {
      // Seed a note so FTS has something to hit.
      await writeFile(join(vault, 'Cars.md'), '# Cars\n\nI drive a fast car.\n');
      await seedPipeline.index(vault);

      // DO NOT resolve or reject the mock embedder — leave init in flight.
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const start = Date.now();
      const result = unwrap(await searchTool.cb({ query: 'car', mode: 'fulltext' }));
      const elapsed = Date.now() - start;

      // Must not block on the slow-mock init.
      expect(elapsed).toBeLessThan(1000);

      // Normal fulltext result: wrapped in {data, context} envelope.
      expect(result).toHaveProperty('data');
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('does not return a status field (no preparing/failed)', async () => {
      const { ctx } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      const { server, registered } = makeMockServer();
      registerSearchTool(server, ctx);
      const searchTool = registered.find((t) => t.name === 'search')!;

      const result = unwrap(await searchTool.cb({ query: 'anything', mode: 'fulltext' }));

      // Fulltext should never return the status sentinel.
      expect(result.status).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // #5 — Non-semantic tools respond without waiting (list_notes)
  // -------------------------------------------------------------------------

  describe('list_notes — no embedder dependency', () => {
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

      // Must not block on the slow-mock init.
      expect(elapsed).toBeLessThan(500);
      expect(Array.isArray(result)).toBe(true);
      expect(result.some((n: { id: string }) => n.id === 'Alpha.md')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // #6 — Write tools return immediately; pipeline.index fires in background
  // -------------------------------------------------------------------------

  describe('create_note — fire-and-forget reindex', () => {
    it('returns the new note path in <500ms while embedder is still initialising', async () => {
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

    it('eventually calls pipeline.index after the embedder resolves', async () => {
      const indexCalls: string[] = [];
      const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      // Spy on pipeline.index — intercept the background reindex call.
      ctx.pipeline.index = async (p: string) => {
        indexCalls.push(p);
        return {
          nodesIndexed: 0,
          nodesSkipped: 0,
          edgesIndexed: 0,
          communitiesDetected: 0,
          stubNodesCreated: 0,
        };
      };

      const { server, registered } = makeMockServer();
      registerCreateNoteTool(server, ctx);
      const createTool = registered.find((t) => t.name === 'create_note')!;

      // Create note while embedder is still downloading.
      await createTool.cb({ title: 'EventualNote', content: 'async content' });

      // index should NOT have been called yet (embedder still in flight).
      expect(indexCalls).toHaveLength(0);

      // Now resolve the embedder (simulating model download completing).
      setReady();

      // Poll until the fire-and-forget background chain delivers the call.
      await new Promise<void>((resolve) => {
        const poll = (): void => {
          if (indexCalls.length > 0) resolve();
          else setTimeout(poll, 20);
        };
        poll();
      });

      expect(indexCalls.length).toBeGreaterThan(0);
      expect(indexCalls[0]).toBe(vault);
    }, 10_000);
  });

  describe('edit_note — fire-and-forget reindex', () => {
    it('returns in <500ms while embedder is still initialising', async () => {
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
      // edit_note returns the vault-relative path (which for files at the root
      // is just the filename, but may include the full path on some impls).
      expect(result.path).toMatch(/EditMe\.md$/);
    });

    it('eventually calls pipeline.index after the embedder resolves', async () => {
      await writeFile(join(vault, 'EditLater.md'), '# EditLater\n\nbody\n');
      await seedPipeline.index(vault);

      const indexCalls: string[] = [];
      const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      ctx.pipeline.index = async (p: string) => {
        indexCalls.push(p);
        return {
          nodesIndexed: 0,
          nodesSkipped: 0,
          edgesIndexed: 0,
          communitiesDetected: 0,
          stubNodesCreated: 0,
        };
      };

      const { server, registered } = makeMockServer();
      registerEditNoteTool(server, ctx);
      const editTool = registered.find((t) => t.name === 'edit_note')!;

      await editTool.cb({ name: 'EditLater', mode: 'append', content: 'more text' });
      expect(indexCalls).toHaveLength(0);

      setReady();

      await new Promise<void>((resolve) => {
        const poll = (): void => {
          if (indexCalls.length > 0) resolve();
          else setTimeout(poll, 20);
        };
        poll();
      });

      expect(indexCalls.length).toBeGreaterThan(0);
    }, 10_000);
  });

  describe('delete_note — fire-and-forget reindex', () => {
    it('returns in <500ms while embedder is still initialising', async () => {
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

    it('eventually calls pipeline.index after the embedder resolves', async () => {
      await writeFile(join(vault, 'DeleteLater.md'), '# DeleteLater\n\nbody\n');
      await seedPipeline.index(vault);

      const indexCalls: string[] = [];
      const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      ctx.pipeline.index = async (p: string) => {
        indexCalls.push(p);
        return {
          nodesIndexed: 0,
          nodesSkipped: 0,
          edgesIndexed: 0,
          communitiesDetected: 0,
          stubNodesCreated: 0,
        };
      };

      const { server, registered } = makeMockServer();
      registerDeleteNoteTool(server, ctx);
      const deleteTool = registered.find((t) => t.name === 'delete_note')!;

      await deleteTool.cb({ name: 'DeleteLater', confirm: true });
      expect(indexCalls).toHaveLength(0);

      setReady();

      await new Promise<void>((resolve) => {
        const poll = (): void => {
          if (indexCalls.length > 0) resolve();
          else setTimeout(poll, 20);
        };
        poll();
      });

      expect(indexCalls.length).toBeGreaterThan(0);
    }, 10_000);
  });

  describe('move_note — fire-and-forget reindex', () => {
    it('returns in <500ms while embedder is still initialising', async () => {
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

    it('eventually calls pipeline.index after the embedder resolves', async () => {
      await writeFile(join(vault, 'MoveLater.md'), '# MoveLater\n\nbody\n');
      await seedPipeline.index(vault);

      const indexCalls: string[] = [];
      const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      ctx.pipeline.index = async (p: string) => {
        indexCalls.push(p);
        return {
          nodesIndexed: 0,
          nodesSkipped: 0,
          edgesIndexed: 0,
          communitiesDetected: 0,
          stubNodesCreated: 0,
        };
      };

      const { server, registered } = makeMockServer();
      registerMoveNoteTool(server, ctx);
      const moveTool = registered.find((t) => t.name === 'move_note')!;

      await moveTool.cb({ source: 'MoveLater', destination: 'MoveLaterRenamed' });
      expect(indexCalls).toHaveLength(0);

      setReady();

      await new Promise<void>((resolve) => {
        const poll = (): void => {
          if (indexCalls.length > 0) resolve();
          else setTimeout(poll, 20);
        };
        poll();
      });

      expect(indexCalls.length).toBeGreaterThan(0);
    }, 10_000);
  });

  describe('link_notes — fire-and-forget reindex', () => {
    it('returns in <500ms while embedder is still initialising', async () => {
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

    it('eventually calls pipeline.index after the embedder resolves', async () => {
      await writeFile(join(vault, 'LinkA.md'), '# LinkA\n\nbody\n');
      await writeFile(join(vault, 'LinkB.md'), '# LinkB\n\nbody\n');
      await seedPipeline.index(vault);

      const indexCalls: string[] = [];
      const { ctx, setReady } = buildCtx(vault, db, seedPipeline, mockEmbedder);

      ctx.pipeline.index = async (p: string) => {
        indexCalls.push(p);
        return {
          nodesIndexed: 0,
          nodesSkipped: 0,
          edgesIndexed: 0,
          communitiesDetected: 0,
          stubNodesCreated: 0,
        };
      };

      const { server, registered } = makeMockServer();
      registerLinkNotesTool(server, ctx);
      const linkTool = registered.find((t) => t.name === 'link_notes')!;

      await linkTool.cb({ source: 'LinkA', target: 'LinkB', context: 'background link test' });
      expect(indexCalls).toHaveLength(0);

      setReady();

      await new Promise<void>((resolve) => {
        const poll = (): void => {
          if (indexCalls.length > 0) resolve();
          else setTimeout(poll, 20);
        };
        poll();
      });

      expect(indexCalls.length).toBeGreaterThan(0);
    }, 10_000);
  });
});
