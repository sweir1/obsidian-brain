import { mkdirSync } from 'fs';
import { openDb, ensureVecTables, type DatabaseHandle } from './store/db.js';
import type { Embedder } from './embeddings/types.js';
import { createEmbedder } from './embeddings/factory.js';
import { Search } from './search/unified.js';
import { VaultWriter } from './vault/writer.js';
import { IndexPipeline } from './pipeline/indexer.js';
import { bootstrap, type BootstrapResult } from './pipeline/bootstrap.js';
import { ObsidianClient } from './obsidian/client.js';
import { resolveConfig, type Config } from './config.js';

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
}

export async function createContext(): Promise<ServerContext> {
  const config = resolveConfig({});
  mkdirSync(config.dataDir, { recursive: true });
  // Native-module load is the first thing that can fail with a
  // NODE_MODULE_VERSION / ERR_DLOPEN_FAILED ABI mismatch — typically from a
  // cached npx install built against a different Node than the one currently
  // running. The raw Node error is long and names a hash-keyed file inside
  // `~/.npm/_npx/…`, which is opaque. Rewrite it into something with a
  // one-line fix so the message is useful when it lands in the MCP host log.
  let db: DatabaseHandle;
  try {
    db = openDb(config.dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(msg)) {
      throw new Error(
        `obsidian-brain: Node ABI mismatch — a native module was compiled for a ` +
          `different Node major version than this runtime ` +
          `(NODE_MODULE_VERSION=${process.versions.modules}, Node ${process.version}).\n` +
          `\n` +
          `Most likely cause: a cached npx install from a previous Node version.\n` +
          `\n` +
          `Fix: rm -rf ~/.npm/_npx   (then restart your MCP client)\n` +
          `\n` +
          `See https://sweir1.github.io/obsidian-brain/troubleshooting/#err_dlopen_failed-node_module_version-mismatch\n` +
          `\n` +
          `Underlying error: ${msg}`,
      );
    }
    throw err;
  }
  const embedder = createEmbedder();
  const search = new Search(db, embedder);
  const writer = new VaultWriter(config.vaultPath, db);
  const pipeline = new IndexPipeline(db, embedder);
  const obsidian = new ObsidianClient(config.vaultPath);

  let bootstrapResult: BootstrapResult | null = null;
  let embedderInitialized = false;

  // Cache the init promise so concurrent callers (e.g. a tool call racing the
  // background startup catchup) share one model load instead of initialising
  // the embedder twice.
  let initPromise: Promise<void> | null = null;
  const ensureEmbedderReady = (): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        await embedder.init();
        // Before anything writes to nodes_vec/chunks_vec, reconcile the
        // stored embedder identity against the live one and (potentially)
        // queue a reindex.
        bootstrapResult = bootstrap(db, embedder);
        ensureVecTables(db, embedder.dimensions());
        embedderInitialized = true;
      })();
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
    enqueueBackgroundReindex(work) {
      // Chain onto the current tail — .finally() runs the work whether
      // the prior chain resolved or rejected, so a failed reindex never
      // blocks subsequent ones. We wrap with .catch() so the tail always
      // resolves (never rejects) — afterEach awaiting this mustn't throw.
      ctx.pendingReindex = ctx.pendingReindex.finally(() => {
        return work().catch((err) => {
          process.stderr.write(
            `obsidian-brain: background reindex failed: ${String(err)}\n`,
          );
        });
      });
    },
  };
  return ctx;
}
