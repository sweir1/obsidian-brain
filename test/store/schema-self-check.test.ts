import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, selfCheckSchema, initSchema, type DatabaseHandle } from '../../src/store/db.js';

const EXPECTED_CAPABILITY_COLS = ['embedder_id', 'model_hash', 'advertised_max_tokens', 'discovered_max_tokens', 'discovered_at', 'method'];
const EXPECTED_FAILED_COLS = ['chunk_id', 'note_id', 'reason', 'error_message', 'failed_at'];

describe('selfCheckSchema', () => {
  let db: DatabaseHandle;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('auto-heals when embedder_capability table is missing', () => {
    db = openDb(':memory:');
    // Manually drop the capability table to simulate stale state.
    db.exec('DROP TABLE embedder_capability');

    // Confirm it's gone.
    const before = (db.prepare("PRAGMA table_info(embedder_capability)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(before).toHaveLength(0);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    selfCheckSchema(db);

    // Table should now exist with the expected columns.
    const after = (db.prepare("PRAGMA table_info(embedder_capability)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of EXPECTED_CAPABILITY_COLS) {
      expect(after).toContain(col);
    }

    // Should have written a warning about the missing table.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('embedder_capability') && msg.includes('missing'))).toBe(true);
  });

  it('warns (but does not throw) on extra columns in failed_chunks', () => {
    db = openDb(':memory:');
    // Add a fake extra column to simulate a DB written by a newer version.
    db.exec('ALTER TABLE failed_chunks ADD COLUMN extra_col TEXT');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Must not throw.
    expect(() => selfCheckSchema(db)).not.toThrow();

    // Should warn about the unexpected column.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('failed_chunks') && msg.includes('extra_col'))).toBe(true);

    // Table is still intact and usable — all expected cols present.
    const cols = (db.prepare("PRAGMA table_info(failed_chunks)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of EXPECTED_FAILED_COLS) {
      expect(cols).toContain(col);
    }
  });

  it('produces no stderr output on a clean v6 DB', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // openDb calls selfCheckSchema internally; capture from the start.
    db = openDb(':memory:');

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const schemaCheckCalls = calls.filter((msg) => msg.includes('schema-check'));
    expect(schemaCheckCalls).toHaveLength(0);
  });

  it('is idempotent — second call produces no stderr and no errors', () => {
    db = openDb(':memory:');

    // First explicit call after openDb (which already called it once).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    selfCheckSchema(db);
    selfCheckSchema(db);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const schemaCheckCalls = calls.filter((msg) => msg.includes('schema-check'));
    expect(schemaCheckCalls).toHaveLength(0);
  });
});
