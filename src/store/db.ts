import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type { Database };

/**
 * Database handle type — alias for better-sqlite3's Database instance.
 * All store functions take one of these as their first argument.
 */
export type DatabaseHandle = Database.Database;

/**
 * Default embedding dimension used when initSchema creates nodes_vec /
 * chunks_vec before an Embedder has declared its own dim. Matches
 * Xenova/bge-small-en-v1.5 (the v1.5.2 default preset) and also the
 * earlier Xenova/all-MiniLM-L6-v2 — both are 384-dim. ensureVecTables()
 * reconciles this against the actual embedder at runtime.
 */
const DEFAULT_EMBEDDING_DIM = 384;

/**
 * Schema version written into `index_metadata` by initSchema. Bumped whenever
 * a structural change requires a one-shot migration on next boot (see
 * `bootstrap.ts` for the migration runner).
 *
 * v1: pre-1.4.0 (nodes_vec + nodes_fts only).
 * v2: v1.4.0 — adds chunks / chunks_vec, index_metadata, and switches
 *     nodes_fts to `porter unicode61` tokenize.
 * v3: v1.5.1 — adds `embedder_prefix_strategy` metadata key for stratified
 *     BGE/E5 prefix migration; fixes dead schema_version branch.
 * v4: v1.6.5 — adds `edges.target_fragment` TEXT column. Heading / block
 *     anchor stubs (`[[X#Section]]`, `[[X^block]]`) now store the bare
 *     target id on `target_id` and the suffix on `target_fragment`, so
 *     `resolveForwardStubs` can migrate them like any other forward-ref.
 * v6: v1.7.0 — adds `embedder_capability` and `failed_chunks` tables for
 *     adaptive capacity tracking and fault-tolerant chunk logging.
 * v7: v1.7.5 — extends `embedder_capability` with metadata-cache columns
 *     (dim, query_prefix, document_prefix, prefix_source, base_model,
 *     size_bytes, fetched_at) so HF model metadata is resolved once + cached
 *     instead of hardcoded across `presets.ts` / `embedder.ts` /
 *     `capacity.KNOWN_MAX_TOKENS`. 90-day TTL on `fetched_at`.
 *
 * Known `index_metadata` keys:
 *   embedding_model, embedding_dim, schema_version, embedder_provider,
 *   embedder_prefix_strategy
 */
export const SCHEMA_VERSION = 7;

/**
 * Open a SQLite database at `dbPath`, enable WAL mode, load the sqlite-vec
 * extension, and initialize the schema. Returns the live handle.
 */
export function openDb(dbPath: string): DatabaseHandle {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  sqliteVec.load(db);
  initSchema(db);
  selfCheckSchema(db);
  return db;
}

/**
 * Create all tables, indexes, and virtual tables (FTS5 + vec0) used by the
 * knowledge graph store. Idempotent — safe to call on an existing database.
 */
export function initSchema(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      frontmatter TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      target_subpath TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

    CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      node_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS sync (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      heading_level INTEGER,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_node_id ON chunks(node_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
      USING fts5(title, content, content='nodes', content_rowid='rowid', tokenize='porter unicode61');

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec
      USING vec0(embedding float[${DEFAULT_EMBEDDING_DIM}]);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
      USING vec0(embedding float[${DEFAULT_EMBEDDING_DIM}]);

    CREATE TABLE IF NOT EXISTS embedder_capability (
      embedder_id TEXT NOT NULL,
      model_hash TEXT NOT NULL,
      advertised_max_tokens INTEGER,
      discovered_max_tokens INTEGER,
      discovered_at INTEGER,
      method TEXT,
      -- v1.7.5 schema v7: metadata-cache columns. Populated by
      -- src/embeddings/metadata-cache.ts; nullable so v6 rows still load.
      dim INTEGER,
      query_prefix TEXT,
      document_prefix TEXT,
      prefix_source TEXT,
      base_model TEXT,
      size_bytes INTEGER,
      fetched_at INTEGER,
      PRIMARY KEY (embedder_id, model_hash)
    );

    CREATE TABLE IF NOT EXISTS failed_chunks (
      chunk_id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      error_message TEXT,
      failed_at INTEGER NOT NULL
    );
  `);
}

/**
 * Read the column dim of a vec0 virtual table from sqlite_master's stored
 * CREATE statement, or null if the table is missing.
 */
function readVecDim(db: DatabaseHandle, tableName: string): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string } | undefined;
  if (!row) return null;
  const match = /float\[(\d+)\]/.exec(row.sql);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Read the tokenize clause of an FTS5 virtual table from sqlite_master, or
 * null if the table is missing / no tokenize clause present.
 */
function readFtsTokenize(db: DatabaseHandle, tableName: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string } | undefined;
  if (!row) return null;
  const match = /tokenize\s*=\s*['"]([^'"]+)['"]/i.exec(row.sql);
  return match?.[1] ?? null;
}

/**
 * Reconcile nodes_vec + chunks_vec dimensions against the embedder's actual
 * output dim. Called once per process after the embedder initialises.
 *
 * - Dims match: no-op.
 * - Dim mismatch and the vec table is empty: drop + recreate at the new dim.
 *   Lets users switch EMBEDDING_MODEL on a fresh install without ceremony.
 * - Dim mismatch and the vec table has rows: refuse, with a clear instruction
 *   to run `obsidian-brain index --drop` and rebuild from scratch. The normal
 *   path via bootstrap.checkEmbeddingCompatibility handles model switches
 *   automatically before we ever hit this check.
 */
export function ensureVecTables(db: DatabaseHandle, dim: number): void {
  ensureSingleVecTable(db, 'nodes_vec', dim);
  ensureSingleVecTable(db, 'chunks_vec', dim);
}

function ensureSingleVecTable(db: DatabaseHandle, tableName: string, dim: number): void {
  const currentDim = readVecDim(db, tableName);
  if (currentDim === dim) return;

  if (currentDim !== null) {
    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }
    ).n;
    if (rowCount > 0) {
      throw new Error(
        `Embedding dimension mismatch: existing ${tableName} has dim ${currentDim}, ` +
          `current model produces dim ${dim}. ` +
          `Re-index from scratch: run \`obsidian-brain index --drop\`.`,
      );
    }
    db.exec(`DROP TABLE ${tableName}`);
  }

  db.exec(`CREATE VIRTUAL TABLE ${tableName} USING vec0(embedding float[${dim}])`);
}

/**
 * Back-compat shim — older call sites pass only the nodes_vec name.
 * @deprecated Prefer {@link ensureVecTables}.
 */
export function ensureVecTable(db: DatabaseHandle, dim: number): void {
  ensureVecTables(db, dim);
}

/**
 * Drop every embedding + sync row so the next index run rebuilds from
 * scratch. Called by `obsidian-brain index --drop`, typically when switching
 * EMBEDDING_MODEL to one with a different output dim.
 *
 * Also clears the chunk table + chunks_vec so a model switch doesn't leave
 * stale per-chunk rows around pointing at the old vector space.
 *
 * v1.7.2: also clears `embedder_capability` and `failed_chunks` (v6 schema
 * tables). Capacity is cheap to re-probe (~50 ms transformers / one HTTP call
 * Ollama) and failed_chunks is pure telemetry — no semantic loss from clearing
 * on a model/provider switch. Without this, stale capacity entries from a
 * prior provider can poison the next reindex with a too-small
 * `discovered_max_tokens` cascade.
 */
export function dropEmbeddingState(db: DatabaseHandle): void {
  db.exec('DROP TABLE IF EXISTS nodes_vec');
  db.exec('DROP TABLE IF EXISTS chunks_vec');
  db.exec('DELETE FROM chunks');
  db.exec('DELETE FROM sync');
  // v1.7.2: also clear v6 capacity + failed_chunks state. Capacity is cheap to
  // re-probe (~50 ms transformers / one HTTP call Ollama) and failed_chunks is
  // pure telemetry — no semantic loss from clearing on a model/provider switch.
  db.exec('DELETE FROM embedder_capability');
  db.exec('DELETE FROM failed_chunks');
}

/**
 * One-shot FTS5 rebuild: drop nodes_fts and recreate it with the current
 * tokenize clause, then re-ingest every row in nodes.
 *
 * Used by the bootstrap migration when an older database was created with
 * the old default-tokenizer FTS table and we want the new porter-stemmed
 * index without forcing a full content re-index.
 */
export function rebuildFullTextIndex(db: DatabaseHandle): void {
  db.exec('DROP TABLE IF EXISTS nodes_fts');
  db.exec(
    `CREATE VIRTUAL TABLE nodes_fts USING fts5(title, content, content='nodes', content_rowid='rowid', tokenize='porter unicode61')`,
  );
  // Repopulate from the canonical nodes table. Use direct INSERT (not the
  // FTS5 'rebuild' command) so it works even though we're using
  // external-content without shadow-content triggers.
  const rows = db
    .prepare('SELECT rowid, title, content FROM nodes')
    .all() as Array<{ rowid: number; title: string; content: string | null }>;
  const insert = db.prepare(
    'INSERT INTO nodes_fts(rowid, title, content) VALUES(?, ?, ?)',
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) insert.run(r.rowid, r.title, r.content ?? '');
  });
  tx(rows);
}

/** Return the current stored FTS tokenize clause, or null if absent. */
export function currentFtsTokenize(db: DatabaseHandle): string | null {
  return readFtsTokenize(db, 'nodes_fts');
}

/**
 * Idempotent in-place migration: ensure `edges.target_fragment` exists
 * (schema v4 addition). Safe to call on any schema version — if the column
 * already exists the ALTER is skipped. Also a no-op on schema v5+ where the
 * column was renamed to target_subpath (the column-check below misses on
 * the new name, so nothing runs).
 */
export function ensureEdgesTargetFragmentColumn(db: DatabaseHandle): void {
  const cols = db
    .prepare("PRAGMA table_info('edges')")
    .all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  // Skip on v5+ DBs: target_subpath already present means the rename
  // migration has run. Don't re-add the old column.
  if (names.includes('target_subpath')) return;
  if (!names.includes('target_fragment')) {
    db.exec('ALTER TABLE edges ADD COLUMN target_fragment TEXT');
  }
}

/**
 * Idempotent in-place migration: rename `edges.target_fragment` →
 * `edges.target_subpath` (schema v5). Aligns with the Obsidian API's
 * `LinkCache.subpath` naming used by Dataview, Juggl, and the official
 * plugin API.
 *
 * Runs in three cases:
 *   - Old column exists and new doesn't → rename (normal upgrade path).
 *   - New column already exists → no-op (fresh v5+ install, or second boot).
 *   - Neither exists → no-op (pre-v4 DB; ensureEdgesTargetFragmentColumn
 *     will run before us in the chain and add target_fragment, then we
 *     rename it).
 */
export function renameTargetFragmentToSubpath(db: DatabaseHandle): void {
  const cols = db
    .prepare("PRAGMA table_info('edges')")
    .all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  if (names.includes('target_subpath')) return; // already renamed
  if (!names.includes('target_fragment')) return; // nothing to rename
  db.exec('ALTER TABLE edges RENAME COLUMN target_fragment TO target_subpath');
}

/**
 * Defensive cross-check between code's expected column set and the live DB.
 *
 * Runs at the end of `openDb` after `initSchema` + bootstrap migrations. For
 * each v1.7.0 table (`embedder_capability`, `failed_chunks`), verifies that
 * `PRAGMA table_info(TABLE)` reports exactly the column set the code reads /
 * writes. If columns are MISSING, calls the corresponding `createXxxTable`
 * helper to add them (idempotent). If columns are EXTRA, warns to stderr but
 * continues — forward-compat for older code reading a newer DB.
 *
 * Catches stale-cache scenarios (npx cached an older version of obsidian-brain
 * that doesn't write/read the same columns the user's DB has) and prevents
 * the obscure "Too few parameter values" bind error that would otherwise fire
 * downstream.
 */
export function selfCheckSchema(db: DatabaseHandle): void {
  interface ColumnInfo { name: string; }
  const expected: Record<string, string[]> = {
    embedder_capability: [
      'embedder_id', 'model_hash', 'advertised_max_tokens', 'discovered_max_tokens', 'discovered_at', 'method',
      // v1.7.5 schema v7 columns:
      'dim', 'query_prefix', 'document_prefix', 'prefix_source', 'base_model', 'size_bytes', 'fetched_at',
    ],
    failed_chunks: ['chunk_id', 'note_id', 'reason', 'error_message', 'failed_at'],
  };

  for (const [table, expectedCols] of Object.entries(expected)) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((c) => c.name);
    if (cols.length === 0) {
      // Table missing entirely — initSchema should have created it. Auto-heal.
      process.stderr.write(`obsidian-brain: schema-check: ${table} missing — recreating via initSchema migration\n`);
      if (table === 'embedder_capability') createEmbedderCapabilityTable(db);
      else if (table === 'failed_chunks') createFailedChunksTable(db);
      continue;
    }
    const missing = expectedCols.filter((c) => !cols.includes(c));
    if (missing.length > 0) {
      // v1.7.5: for embedder_capability the missing columns are always the v7
      // additions, which are nullable and safe to ALTER TABLE in place. Heal.
      if (table === 'embedder_capability') {
        ensureEmbedderCapabilityV7Columns(db);
      } else {
        process.stderr.write(`obsidian-brain: schema-check: ${table} is missing columns [${missing.join(', ')}] — drop+recreate this table to recover\n`);
      }
    }
    const extra = cols.filter((c) => !expectedCols.includes(c));
    if (extra.length > 0) {
      // Forward-compat: an older code version is reading a newer DB. Warn but continue.
      process.stderr.write(`obsidian-brain: schema-check: ${table} has unexpected columns [${extra.join(', ')}] (forward-compat from a newer version)\n`);
    }
  }
}

/**
 * Idempotent migration (schema v6 + v7): create `embedder_capability` table
 * used by the adaptive capacity module to cache per-model context-length
 * probes (v6) and HF metadata (v7 — dim/prefix/etc).
 *
 * Calls `ensureEmbedderCapabilityV7Columns` afterwards so a v6 install gets
 * the v7 columns added on the next openDb. Safe on every boot.
 */
export function createEmbedderCapabilityTable(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedder_capability (
      embedder_id TEXT NOT NULL,
      model_hash TEXT NOT NULL,
      advertised_max_tokens INTEGER,
      discovered_max_tokens INTEGER,
      discovered_at INTEGER,
      method TEXT,
      dim INTEGER,
      query_prefix TEXT,
      document_prefix TEXT,
      prefix_source TEXT,
      base_model TEXT,
      size_bytes INTEGER,
      fetched_at INTEGER,
      PRIMARY KEY (embedder_id, model_hash)
    );
  `);
  ensureEmbedderCapabilityV7Columns(db);
}

/**
 * Idempotent v6 → v7 migration helper. Adds the seven metadata-cache columns
 * to `embedder_capability` if they're missing. PRAGMA-guarded so re-running
 * is a no-op on tables that already have them.
 */
export function ensureEmbedderCapabilityV7Columns(db: DatabaseHandle): void {
  interface ColumnInfo { name: string }
  const cols = (db.prepare('PRAGMA table_info(embedder_capability)').all() as ColumnInfo[]).map((c) => c.name);
  const want: Array<{ name: string; type: string }> = [
    { name: 'dim', type: 'INTEGER' },
    { name: 'query_prefix', type: 'TEXT' },
    { name: 'document_prefix', type: 'TEXT' },
    { name: 'prefix_source', type: 'TEXT' },
    { name: 'base_model', type: 'TEXT' },
    { name: 'size_bytes', type: 'INTEGER' },
    { name: 'fetched_at', type: 'INTEGER' },
  ];
  for (const col of want) {
    if (!cols.includes(col.name)) {
      db.exec(`ALTER TABLE embedder_capability ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Idempotent migration (schema v6): create `failed_chunks` table used by
 * the fault-tolerant indexer to record chunks that could not be embedded.
 */
export function createFailedChunksTable(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS failed_chunks (
      chunk_id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      error_message TEXT,
      failed_at INTEGER NOT NULL
    );
  `);
}
