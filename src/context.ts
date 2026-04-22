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
 * before touching semantic search. First call downloads the ~22MB model, so
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
}

export async function createContext(): Promise<ServerContext> {
  const config = resolveConfig({});
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(config.dbPath);
  const embedder = createEmbedder();
  const search = new Search(db, embedder);
  const writer = new VaultWriter(config.vaultPath, db);
  const pipeline = new IndexPipeline(db, embedder);
  const obsidian = new ObsidianClient(config.vaultPath);

  let bootstrapResult: BootstrapResult | null = null;

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
      })();
    }
    return initPromise;
  };

  return {
    db,
    embedder,
    search,
    writer,
    pipeline,
    config,
    obsidian,
    ensureEmbedderReady,
    getBootstrap: () => bootstrapResult,
  };
}
