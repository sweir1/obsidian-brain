import { mkdirSync } from 'node:fs';
import { openDb, ensureVecTables, type DatabaseHandle } from './store/db.js';
import type { Embedder } from './embeddings/types.js';
import { createEmbedder } from './embeddings/factory.js';
import { Search } from './search/unified.js';
import { VaultWriter } from './vault/writer.js';
import { IndexPipeline } from './pipeline/indexer.js';
import { bootstrap, type BootstrapResult } from './pipeline/bootstrap.js';
import { resolveModelMetadata } from './embeddings/metadata-resolver.js';
import { ObsidianClient } from './obsidian/client.js';
import { resolveConfig, type Config } from './config.js';
import { isLikelyAbiFailure, tryAutoHealAbiMismatch } from './auto-heal.js';
import { errorMessage } from './util/errors.js';
import { debugLog } from './util/debug-log.js';

debugLog('module-load: src/context.ts');

/**
 * Shared runtime state that every tool handler needs. Constructed once at
 * server startup and captured by each tool's registration closure.
 *
 * `embedder` is instantiated but NOT initialized — call `ensureEmbedderReady`
 * before touching semantic search. First call downloads the default
 * embedding model (~34MB for the v1.5.2 default bge-small-en-v1.5), so
 * we defer it until actually needed.
 *
 * `getBootstrap` returns the result of the last startup compatibility check
 * (model/schema change detection). `null` until `ensureEmbedderReady` has
 * run at least once — the check can't happen until the embedder knows its
 * dimensions.
 */
export interface ServerContext {
  db: DatabaseHandle;
  embedder: Embedder;
  search: Search;
  writer: VaultWriter;
  pipeline: IndexPipeline;
  config: Config;
  obsidian: ObsidianClient;
  ensureEmbedderReady: () => Promise<void>;
  getBootstrap: () => BootstrapResult | null;
  embedderReady: () => boolean;
  initError: unknown | undefined;
  /**
   * Tracks the tail of the fire-and-forget reindex chain from write tools.
   * In production nothing awaits this — the writes return immediately and
   * the reindex drains in the background. In tests, afterEach awaits
   * `ctx.pendingReindex` before tearing down the temp vault / closing the
   * DB so the trailing reindex doesn't ENOENT against a deleted directory.
   * Always a resolved promise when no work is queued.
   */
  pendingReindex: Promise<void>;
  /**
   * Internal hook — write tools call this to chain their fire-and-forget
   * reindex onto the tail of `pendingReindex`. Not part of the user API.
   */
  enqueueBackgroundReindex: (work: () => Promise<void>) => void;
  /**
   * True while a background reindex is actively running (e.g. triggered by a
   * PREFIX_STRATEGY_VERSION bump or embedder change). Distinct from the
   * embedder-not-yet-ready state — allows search to surface a more accurate
   * "re-embedding in progress" message instead of the "still downloading"
   * first-run message.
   */
  reindexInProgress: boolean;
  /**
   * v1.7.20 C8: reason recorded when the user triggered a reindex via the
   * `reindex` tool (as opposed to a bootstrap migration trigger). Read by
   * `index_status.lastReindexReasons`, merged with bootstrap migration
   * reasons. Null until the first manual reindex; persists in-process only.
   */
  lastManualReindexReason: string | null;
}

export async function createContext(): Promise<ServerContext> {
  debugLog('createContext: entry, calling resolveConfig');
  const config = resolveConfig({});
  debugLog(`createContext: resolveConfig OK (dataDir=${config.dataDir}, vault=${config.vaultPath})`);
  mkdirSync(config.dataDir, { recursive: true });
  debugLog('createContext: dataDir created/verified, calling openDb');
  let db: DatabaseHandle;
  try {
    db = openDb(config.dbPath);
    debugLog('createContext: openDb OK');
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (isLikelyAbiFailure(msg)) {
      // Whatever path produced the error, route through auto-heal. The most
      // common case here is `new Database(...)` throwing at construction
      // time even though `import 'better-sqlite3'` succeeded — the
      // top-level-import failure mode is caught earlier by preflight.
      // Default the failing-module hint to better-sqlite3 since openDb
      // calls it first; sqlite-vec failures from db.ts:loadExtension also
      // commonly surface as ERR_DLOPEN_FAILED here, but rebuild target
      // doesn't matter for the next-restart UX — both messages tell the
      // user to restart their client after the heal runs.
      tryAutoHealAbiMismatch(msg, 'better-sqlite3');
    }
    throw err;
  }
  debugLog('createContext: calling createEmbedder');
  const embedder = createEmbedder();
  debugLog(`createContext: createEmbedder OK (provider=${embedder.providerName?.() ?? '?'}, model=${embedder.modelIdentifier?.() ?? '?'})`);
  const search = new Search(db, embedder);
  const writer = new VaultWriter(config.vaultPath, db);
  const pipeline = new IndexPipeline(db, embedder);
  const obsidian = new ObsidianClient(config.vaultPath);
  debugLog('createContext: search/writer/pipeline/obsidian wiring complete');

  let bootstrapResult: BootstrapResult | null = null;
  let embedderInitialized = false;

  // Cache the init promise so concurrent callers (e.g. a tool call racing the
  // background startup catchup) share one model load instead of initialising
  // the embedder twice.
  let initPromise: Promise<void> | null = null;
  const ensureEmbedderReady = (): Promise<void> => {
    if (!initPromise) {
      debugLog('ensureEmbedderReady: first call — building init promise');
      initPromise = (async () => {
        debugLog('ensureEmbedderReady: calling embedder.init() (may download model on first run)');
        await embedder.init();
        debugLog(`ensureEmbedderReady: embedder.init() OK (dim=${embedder.dimensions()})`);
        // v1.7.5: resolve metadata (cache → seed → HF) and push onto the
        // embedder so it knows the correct query/document prefix before
        // any embed() call. Bootstrap reads the prefix off the embedder
        // synchronously to compute the prefix-strategy hash. The resolver
        // never throws — it has internal fallbacks down to safe defaults.
        // Tested end-to-end via the smoke harness; the resolver itself is
        // covered by `test/embeddings/metadata-resolver.test.ts`.
        /* v8 ignore start */
        debugLog('ensureEmbedderReady: resolving model metadata (cache → seed → HF)');
        const meta = await resolveModelMetadata(embedder.modelIdentifier(), { db, embedder });
        debugLog('ensureEmbedderReady: metadata resolved, calling embedder.setMetadata');
        embedder.setMetadata?.(meta);
        /* v8 ignore stop */
        // Before anything writes to nodes_vec/chunks_vec, reconcile the
        // stored embedder identity against the live one and (potentially)
        // queue a reindex.
        debugLog('ensureEmbedderReady: calling bootstrap (model/schema reconciliation)');
        bootstrapResult = bootstrap(db, embedder);
        debugLog(`ensureEmbedderReady: bootstrap returned (needsReindex=${bootstrapResult?.needsReindex ?? false})`);
        ensureVecTables(db, embedder.dimensions());
        debugLog('ensureEmbedderReady: vec tables ensured, init COMPLETE');
        embedderInitialized = true;
      })();
      // v1.7.20 N3: centralised initError capture. Fires for every rejection
      // regardless of which caller awaits — `server.ts`'s background block,
      // tool handlers, the watcher, etc. all see the same rejected promise,
      // and `index_status.initError` now reflects the failure even when the
      // background block hasn't observed it yet. Uses `??` so the first
      // error wins (idempotent across concurrent awaits of the rejection).
      // The `server.ts` background catch is kept for its operator-visible
      // stderr line; this capture is silent state.
      initPromise.catch((err: unknown) => {
        ctx.initError ??= err;
      });
    }
    return initPromise;
  };

  const ctx: ServerContext = {
    db,
    embedder,
    search,
    writer,
    pipeline,
    config,
    obsidian,
    ensureEmbedderReady,
    getBootstrap: () => bootstrapResult,
    embedderReady: () => embedderInitialized,
    initError: undefined,
    pendingReindex: Promise.resolve(),
    reindexInProgress: false,
    lastManualReindexReason: null,
    enqueueBackgroundReindex(work) {
      // Chain onto the current tail — .finally() runs the work whether
      // the prior chain resolved or rejected, so a failed reindex never
      // blocks subsequent ones. We wrap with try/finally to track
      // reindexInProgress so search can surface accurate status messages.
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
