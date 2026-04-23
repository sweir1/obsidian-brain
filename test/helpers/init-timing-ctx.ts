/**
 * ServerContext builder for init-timing tests that want to drive the embedder
 * init state by hand.
 *
 * embedderReady and initError are backed by closed-over mutable bindings so
 * the ctx object always reflects the current state. We cannot use getters on
 * an object literal because `as unknown as ServerContext` strips getter
 * descriptors — embedderReady is a function (matches the interface), and
 * initError is a real accessor on the returned ctx.
 */

import type { DatabaseHandle } from '../../src/store/db.js';
import type { IndexPipeline } from '../../src/pipeline/indexer.js';
import { VaultWriter } from '../../src/vault/writer.js';
import { Search } from '../../src/search/unified.js';
import type { ServerContext } from '../../src/context.js';
import { InstantMockEmbedder, SlowMockEmbedder } from './mock-embedders.js';

export interface CtxHandle {
  ctx: ServerContext;
  /** Resolve the mock embedder init — simulates successful model download. */
  setReady: () => void;
  /** Reject the mock embedder init — simulates download failure. */
  setFailed: (err: unknown) => void;
}

export function buildCtx(
  vault: string,
  db: DatabaseHandle,
  pipeline: IndexPipeline,
  mockEmbedder: SlowMockEmbedder,
): CtxHandle {
  const writer = new VaultWriter(vault, db);
  const search = new Search(db, mockEmbedder);

  let embedderInitialized = false;
  let initError: unknown = undefined;

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
    embedderReady: () => embedderInitialized,
    get initError() { return initError; },
    pendingReindex: Promise.resolve(),
    enqueueBackgroundReindex(work: () => Promise<void>): void {
      ctx.pendingReindex = ctx.pendingReindex.finally(() => {
        return work().catch((err: unknown) => {
          process.stderr.write(
            `obsidian-brain: background reindex failed: ${String(err)}\n`,
          );
        });
      });
    },
  } as unknown as ServerContext;

  const setReady = (): void => mockEmbedder.resolveInit();
  const setFailed = (err: unknown): void => mockEmbedder.rejectInit(err);

  return { ctx, setReady, setFailed };
}

/**
 * Shared InstantMockEmbedder for "seed" pipelines across all init-timing
 * suites. One instance per process is fine because it holds no mutable state.
 */
export const seedEmbedder = new InstantMockEmbedder();
