import type { DatabaseHandle } from './db.js';

/**
 * Tiny key/value store used for index-wide metadata (embedder identity,
 * schema version, etc.). Separate from `sync` so schema migrations and
 * model-change detection don't collide with per-file mtime tracking.
 */

/**
 * Read a metadata value by key. Returns undefined if the key has never
 * been written.
 */
export function getMetadata(db: DatabaseHandle, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM index_metadata WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Insert or replace a metadata value. `updated_at` is stamped with the
 * current wall-clock millisecond on every write.
 */
export function setMetadata(db: DatabaseHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO index_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

/**
 * Remove a metadata key. No-op if the key is absent.
 */
export function deleteMetadata(db: DatabaseHandle, key: string): void {
  db.prepare('DELETE FROM index_metadata WHERE key = ?').run(key);
}
