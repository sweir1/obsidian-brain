import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getMetadata, setMetadata, deleteMetadata } from '../../src/store/metadata.js';

describe('store/metadata', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('getMetadata returns undefined for an unknown key', () => {
    expect(getMetadata(db, 'nope')).toBeUndefined();
  });

  it('setMetadata inserts and getMetadata reads it back', () => {
    setMetadata(db, 'embedding_model', 'Xenova/all-MiniLM-L6-v2');
    expect(getMetadata(db, 'embedding_model')).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('setMetadata replaces on conflict', () => {
    setMetadata(db, 'embedding_dim', '384');
    setMetadata(db, 'embedding_dim', '768');
    expect(getMetadata(db, 'embedding_dim')).toBe('768');
  });

  it('updated_at advances on each write', async () => {
    setMetadata(db, 'k', 'v1');
    const first = db.prepare('SELECT updated_at FROM index_metadata WHERE key = ?').get('k') as { updated_at: number };
    await new Promise((r) => setTimeout(r, 2));
    setMetadata(db, 'k', 'v2');
    const second = db.prepare('SELECT updated_at FROM index_metadata WHERE key = ?').get('k') as { updated_at: number };
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
  });

  it('deleteMetadata removes the key', () => {
    setMetadata(db, 'doomed', 'yes');
    deleteMetadata(db, 'doomed');
    expect(getMetadata(db, 'doomed')).toBeUndefined();
  });

  it('deleteMetadata is a no-op for missing keys', () => {
    expect(() => deleteMetadata(db, 'never-existed')).not.toThrow();
  });
});
