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
 * Xenova/all-MiniLM-L6-v2. ensureVecTables() reconciles this against the
 * actual embedder at runtime.
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
 */
export const SCHEMA_VERSION = 2;

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
      context TEXT NOT NULL DEFAULT ''
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
 */
export function dropEmbeddingState(db: DatabaseHandle): void {
  db.exec('DROP TABLE IF EXISTS nodes_vec');
  db.exec('DROP TABLE IF EXISTS chunks_vec');
  db.exec('DELETE FROM chunks');
  db.exec('DELETE FROM sync');
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
