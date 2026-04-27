import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

/**
 * v1.6.10 introduced the ABI-mismatch guard. v1.6.11 added auto-heal:
 * on ABI error, spawn a detached `npm rebuild better-sqlite3
 * --update-binary` in the background and tell the user to restart.
 * A per-ABI marker file prevents infinite-heal loops.
 */

const runtimeAbi = process.versions.modules;
// v1.7.7: marker filename now includes the failing module name so
// better-sqlite3 and sqlite-vec heals can coexist without sharing a marker.
const markerPath = join(
  homedir(),
  '.cache',
  'obsidian-brain',
  `abi-heal-attempted-better-sqlite3-${runtimeAbi}`,
);
// Pre-v1.7.7 marker (no module-name segment) — clean it up too in case a
// stale one is on disk from a previous test run.
const legacyMarkerPath = join(
  homedir(),
  '.cache',
  'obsidian-brain',
  `abi-heal-attempted-${runtimeAbi}`,
);

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function removeMarker(): void {
  try {
    rmSync(markerPath, { force: true });
    rmSync(legacyMarkerPath, { force: true });
  } catch {
    /* best-effort */
  }
}

describe('createContext() — Node ABI mismatch guard + auto-heal', () => {
  let tmpDataDir: string;
  let tmpVaultDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDataDir = mkdtempSync(join(tmpdir(), 'ob-ctx-data-'));
    tmpVaultDir = mkdtempSync(join(tmpdir(), 'ob-ctx-vault-'));
    removeMarker();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    rmSync(tmpDataDir, { recursive: true, force: true });
    rmSync(tmpVaultDir, { recursive: true, force: true });
    removeMarker();
  });

  it('first ABI mismatch: auto-heal spawns rebuild and throws "restart your MCP client" message', async () => {
    vi.doMock('../src/store/db.js', async (importActual) => {
      const actual: Record<string, unknown> = await importActual();
      return {
        ...actual,
        openDb: vi.fn(() => {
          throw new Error(
            'The module \'better_sqlite3.node\' was compiled against NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 137.',
          );
        }),
      };
    });

    // Mock spawn so we don't actually invoke `npm rebuild`. Capture the call
    // to assert we asked for the right thing.
    const spawnMock = vi.fn(() => ({
      pid: 99999,
      unref: () => undefined,
    }));
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    // CRITICAL: mock fs.unlinkSync so the auto-heal's "delete stale binary"
    // step doesn't actually nuke the real better_sqlite3.node from this
    // repo's node_modules (which would break every other test that needs
    // the native module to load). Preserve everything else in fs real —
    // the writeFileSync for marker/log goes to real tmp paths, which the
    // afterEach cleans up.
    vi.doMock('fs', async (importActual) => {
      const actual = await importActual<typeof import('fs')>();
      return { ...actual, unlinkSync: vi.fn() };
    });

    await withEnv({ DATA_DIR: tmpDataDir, VAULT_PATH: tmpVaultDir }, async () => {
      const { createContext } = await import('../src/context.js');

      // Invoke ONCE and capture the thrown error — subsequent calls would
      // hit the marker we just wrote and get the "already attempted" path,
      // so we can't re-call createContext() for multiple assertions.
      const err = await createContext().then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(err).toBeInstanceOf(Error);

      // Windows: bypass auto-heal entirely.
      if (process.platform === 'win32') {
        expect(err!.message).toMatch(/rm -rf ~\/\.npm\/_npx/);
        return;
      }

      expect(err!.message).toMatch(/Auto-heal/);
      expect(err!.message).toMatch(/restart your MCP client/);
      expect(err!.message).toMatch(new RegExp(`NODE_MODULE_VERSION=${runtimeAbi}`));

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe('npm');
      // Plain `npm rebuild better-sqlite3` — no --update-binary (that flag
      // is for node-pre-gyp; better-sqlite3 uses prebuild-install).
      expect(spawnMock.mock.calls[0]?.[1]).toEqual(['rebuild', 'better-sqlite3']);
      expect(existsSync(markerPath)).toBe(true);
    });
  });

  it('second ABI mismatch (marker exists): no re-spawn, falls back to manual fix message', async () => {
    // Pre-seed the marker as if a prior boot already tried.
    mkdirSync(join(homedir(), '.cache', 'obsidian-brain'), { recursive: true });
    writeFileSync(markerPath, runtimeAbi);

    vi.doMock('../src/store/db.js', async (importActual) => {
      const actual: Record<string, unknown> = await importActual();
      return {
        ...actual,
        openDb: vi.fn(() => {
          throw new Error(
            'The module \'better_sqlite3.node\' was compiled against NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 137.',
          );
        }),
      };
    });

    const spawnMock = vi.fn();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    await withEnv({ DATA_DIR: tmpDataDir, VAULT_PATH: tmpVaultDir }, async () => {
      const { createContext } = await import('../src/context.js');
      if (process.platform === 'win32') return;

      const err = await createContext().then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/auto-heal already attempted/);
      expect(err!.message).toMatch(/rm -rf ~\/\.npm\/_npx/);
      expect(err!.message).toMatch(/xcode-select --install/);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it('passes through non-ABI errors unchanged', async () => {
    vi.doMock('../src/store/db.js', async (importActual) => {
      const actual: Record<string, unknown> = await importActual();
      return {
        ...actual,
        openDb: vi.fn(() => {
          throw new Error('ENOSPC: no space left on device');
        }),
      };
    });

    await withEnv({ DATA_DIR: tmpDataDir, VAULT_PATH: tmpVaultDir }, async () => {
      const { createContext } = await import('../src/context.js');
      const err = await createContext().then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/ENOSPC/);
      expect(err!.message).not.toMatch(/Node ABI mismatch/);
    });
  });
});

/**
 * Tests for enqueueBackgroundReindex's reindexInProgress tracking.
 *
 * These tests build a minimal ctx-like object that mirrors the production
 * enqueueBackgroundReindex implementation directly, avoiding the need to
 * call createContext() (which carries vi.doMock contamination risk from
 * the ABI-mismatch tests above and incurs full embedder/pipeline setup).
 */
describe('enqueueBackgroundReindex — reindexInProgress tracking', () => {
  /** Build a minimal object that mirrors the production implementation. */
  function makeCtx() {
    const ctx = {
      reindexInProgress: false,
      pendingReindex: Promise.resolve() as Promise<void>,
      enqueueBackgroundReindex(work: () => Promise<void>): void {
        ctx.pendingReindex = ctx.pendingReindex.finally(async () => {
          try {
            ctx.reindexInProgress = true;
            await work();
          } catch (err) {
            process.stderr.write(
              `obsidian-brain: background reindex failed: ${String(err)}\n`,
            );
          } finally {
            ctx.reindexInProgress = false;
          }
        });
      },
    };
    return ctx;
  }

  it('sets reindexInProgress to true during work and false after', async () => {
    const ctx = makeCtx();

    let seenDuringWork: boolean | undefined;
    let duringWorkRan = false;

    ctx.enqueueBackgroundReindex(async () => {
      seenDuringWork = ctx.reindexInProgress;
      duringWorkRan = true;
    });

    await ctx.pendingReindex;

    expect(seenDuringWork).toBe(true);
    expect(ctx.reindexInProgress).toBe(false);
    expect(duringWorkRan).toBe(true);
  });

  it('resets reindexInProgress to false even when work throws', async () => {
    const ctx = makeCtx();

    ctx.enqueueBackgroundReindex(async () => {
      throw new Error('simulated reindex failure');
    });

    await ctx.pendingReindex;

    expect(ctx.reindexInProgress).toBe(false);
  });

  it('serializes consecutive enqueued work (FIFO)', async () => {
    const ctx = makeCtx();

    const order: number[] = [];
    ctx.enqueueBackgroundReindex(async () => { order.push(1); });
    ctx.enqueueBackgroundReindex(async () => { order.push(2); });
    ctx.enqueueBackgroundReindex(async () => { order.push(3); });

    await ctx.pendingReindex;

    expect(order).toEqual([1, 2, 3]);
  });

  it('reindexInProgress is false before any work is enqueued', () => {
    const ctx = makeCtx();
    expect(ctx.reindexInProgress).toBe(false);
  });

  // L1 (v1.7.19): the SIGTERM shutdown path must drain `pendingReindex`
  // before closing the DB. Without the drain, in-flight community-detection
  // / graph-rebuild writes hit the closed handle and emit the noisy
  // "TypeError: The database connection is not open" stderr line.
  it('shutdown await-pattern drains in-flight work before tearing down resources', async () => {
    const ctx = makeCtx();

    let workCompleted = false;
    let resourceClosedAt: number | null = null;
    let workCompletedAt: number | null = null;

    ctx.enqueueBackgroundReindex(async () => {
      // Simulate slow background work — DB writes, Louvain, etc.
      await new Promise((resolve) => setTimeout(resolve, 80));
      workCompleted = true;
      workCompletedAt = Date.now();
    });

    // Mirror the server.ts shutdown pattern: bounded await, then close.
    await Promise.race([
      ctx.pendingReindex.catch(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 3_000).unref();
      }),
    ]);
    resourceClosedAt = Date.now();

    expect(workCompleted).toBe(true);
    expect(resourceClosedAt).not.toBeNull();
    expect(workCompletedAt).not.toBeNull();
    // Work must have finished BEFORE we recorded "resources closed."
    expect(workCompletedAt!).toBeLessThanOrEqual(resourceClosedAt!);
  });

  it('shutdown await-pattern times out when work hangs (3s cap)', async () => {
    const ctx = makeCtx();

    let workCompleted = false;
    ctx.enqueueBackgroundReindex(async () => {
      // Never resolve — simulates a stuck reindex.
      await new Promise(() => {});
      workCompleted = true;
    });

    // Use a 50ms cap (instead of 3000ms) for test speed; same pattern.
    const start = Date.now();
    await Promise.race([
      ctx.pendingReindex.catch(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 50).unref();
      }),
    ]);
    const elapsed = Date.now() - start;

    expect(workCompleted).toBe(false);
    // The race must have resolved via the timeout, not the (hung) work.
    expect(elapsed).toBeLessThan(500);
  });
});

// v1.7.20 Fix 3 (N3): rejected initPromise must populate ctx.initError
// even if no caller has awaited it yet. The `index_status` tool reads the
// field directly without awaiting `ensureEmbedderReady()`, so it relies on
// the centralised .catch attached to initPromise at construction.
describe('Fix 3 (N3) — central initError capture from rejected initPromise', () => {
  it('captures rejection into ctx.initError without any awaiter', async () => {
    const ctx: { initError: unknown } = { initError: undefined };
    let initPromise: Promise<void> | null = null;
    const ensureEmbedderReady = (): Promise<void> => {
      if (!initPromise) {
        initPromise = (async () => {
          throw new Error('embedder init failed (simulated)');
        })();
        // The centralised capture pattern from src/context.ts.
        initPromise.catch((err: unknown) => {
          ctx.initError ??= err;
        });
      }
      return initPromise;
    };
    // Trigger init but DO NOT await — emulating what tool-handler bypass
    // looks like before any caller observes the rejection.
    void ensureEmbedderReady();
    // Microtask drain — the promise has rejected, the .catch has fired.
    await new Promise((r) => setImmediate(r));
    expect(ctx.initError).toBeInstanceOf(Error);
    expect((ctx.initError as Error).message).toMatch(/embedder init failed/);
  });

  it('first error wins (??=) on concurrent awaits of the same rejection', async () => {
    const ctx: { initError: unknown } = { initError: undefined };
    const initPromise = (async () => {
      throw new Error('first');
    })();
    initPromise.catch((err: unknown) => {
      ctx.initError ??= err;
    });
    // Multiple awaits all see the same rejection.
    await Promise.allSettled([initPromise, initPromise, initPromise]);
    expect((ctx.initError as Error).message).toBe('first');
    // A subsequent error attempt does NOT overwrite (?? guard).
    ctx.initError ??= new Error('second');
    expect((ctx.initError as Error).message).toBe('first');
  });
});
