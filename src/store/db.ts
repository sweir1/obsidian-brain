import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type { Database };

/**
 * Database handle type — alias for better-sqlite3's Database instance.
 * All store functions take one of these as their first argument.
 */
export type DatabaseHandle = Database.Database;

/**
 * Default embedding dimension used when initSchema creates nodes_vec before
 * an Embedder has declared its own dim. Matches Xenova/all-MiniLM-L6-v2.
 * ensureVecTable() reconciles this against the actual embedder at runtime.
 */
const DEFAULT_EMBEDDING_DIM = 384;

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

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
      USING fts5(title, content, content='nodes', content_rowid='rowid');

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec
      USING vec0(embedding float[${DEFAULT_EMBEDDING_DIM}]);
  `);
}

/**
 * Read the column dim of the current nodes_vec virtual table from
 * sqlite_master's stored CREATE statement, or null if the table is missing.
 */
function readVecDim(db: DatabaseHandle): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes_vec'")
    .get() as { sql: string } | undefined;
  if (!row) return null;
  const match = /float\[(\d+)\]/.exec(row.sql);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Reconcile the nodes_vec virtual table's embedding dimension against the
 * embedder's actual output dim. Called once per process after the embedder
 * initialises.
 *
 * - Dims match: no-op.
 * - Dim mismatch and the vec table is empty: drop + recreate at the new dim.
 *   Lets users switch EMBEDDING_MODEL on a fresh install without ceremony.
 * - Dim mismatch and the vec table has rows: refuse, with a clear instruction
 *   to run `obsidian-brain index --drop` and rebuild from scratch.
 */
export function ensureVecTable(db: DatabaseHandle, dim: number): void {
  const currentDim = readVecDim(db);
  if (currentDim === dim) return;

  if (currentDim !== null) {
    const rowCount = (
      db.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get() as { n: number }
    ).n;
    if (rowCount > 0) {
      throw new Error(
        `Embedding dimension mismatch: existing index has dim ${currentDim}, ` +
          `current model produces dim ${dim}. ` +
          `Re-index from scratch: run \`obsidian-brain index --drop\`.`,
      );
    }
    db.exec('DROP TABLE nodes_vec');
  }

  db.exec(`CREATE VIRTUAL TABLE nodes_vec USING vec0(embedding float[${dim}])`);
}

/**
 * Drop every embedding + sync row so the next index run rebuilds from
 * scratch. Called by `obsidian-brain index --drop`, typically when switching
 * EMBEDDING_MODEL to one with a different output dim.
 */
export function dropEmbeddingState(db: DatabaseHandle): void {
  db.exec('DROP TABLE IF EXISTS nodes_vec');
  db.exec('DELETE FROM sync');
}
