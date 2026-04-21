import { mkdirSync } from 'fs';
import { openDb, ensureVecTable, type DatabaseHandle } from './store/db.js';
import { Embedder } from './embeddings/embedder.js';
import { Search } from './search/unified.js';
import { VaultWriter } from './vault/writer.js';
import { IndexPipeline } from './pipeline/indexer.js';
import { resolveConfig, type Config } from './config.js';

/**
 * Shared runtime state that every tool handler needs. Constructed once at
 * server startup and captured by each tool's registration closure.
 *
 * `embedder` is instantiated but NOT initialized — call `ensureEmbedderReady`
 * before touching semantic search. First call downloads the ~22MB model, so
 * we defer it until actually needed.
 */
export interface ServerContext {
  db: DatabaseHandle;
  embedder: Embedder;
  search: Search;
  writer: VaultWriter;
  pipeline: IndexPipeline;
  config: Config;
  ensureEmbedderReady: () => Promise<void>;
}

export async function createContext(): Promise<ServerContext> {
  const config = resolveConfig({});
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(config.dbPath);
  const embedder = new Embedder();
  const search = new Search(db, embedder);
  const writer = new VaultWriter(config.vaultPath, db);
  const pipeline = new IndexPipeline(db, embedder);

  // Cache the init promise so concurrent callers (e.g. a tool call racing the
  // background startup catchup) share one model load instead of initialising
  // the embedder twice.
  let initPromise: Promise<void> | null = null;
  const ensureEmbedderReady = (): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        await embedder.init();
        ensureVecTable(db, embedder.dim);
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
    ensureEmbedderReady,
  };
}
