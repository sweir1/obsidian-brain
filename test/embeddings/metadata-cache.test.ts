/**
 * v1.7.5 Layer 4 — `embedder_capability` v7-column persistence + 90d TTL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import {
  loadCachedMetadata,
  upsertCachedMetadata,
  clearMetadataCache,
} from '../../src/embeddings/metadata-cache.js';

describe('metadata-cache', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a metadata write and read', () => {
    upsertCachedMetadata(db, {
      modelId: 'BAAI/bge-small-en-v1.5',
      dim: 384,
      maxTokens: 512,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      documentPrefix: '',
      prefixSource: 'seed',
      baseModel: null,
      sizeBytes: 35200000,
      fetchedAt: 1700000000000,
    });

    const loaded = loadCachedMetadata(db, 'BAAI/bge-small-en-v1.5');
    expect(loaded).not.toBeNull();
    expect(loaded?.dim).toBe(384);
    expect(loaded?.maxTokens).toBe(512);
    expect(loaded?.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(loaded?.prefixSource).toBe('seed');
    expect(loaded?.fetchedAt).toBe(1700000000000);
  });

  it('returns null for an absent model id', () => {
    expect(loadCachedMetadata(db, 'never/seen')).toBeNull();
  });

  it('treats v6 rows (no fetched_at) as a cache miss', () => {
    // Manually insert a v6-style row (no v7 column values).
    db.prepare(
      `INSERT INTO embedder_capability (
        embedder_id, model_hash, advertised_max_tokens, discovered_max_tokens, discovered_at, method
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('legacy/model', 'a'.repeat(32), 512, 512, 1700000000000, 'tokenizer_config');

    expect(loadCachedMetadata(db, 'legacy/model')).toBeNull();
  });

  it('upsert overwrites existing v7 columns', () => {
    upsertCachedMetadata(db, {
      modelId: 'a/b',
      dim: 384,
      maxTokens: 512,
      queryPrefix: 'old: ',
      documentPrefix: '',
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: 1000,
    });
    upsertCachedMetadata(db, {
      modelId: 'a/b',
      dim: 768,
      maxTokens: 8192,
      queryPrefix: 'new: ',
      documentPrefix: 'doc: ',
      prefixSource: 'metadata',
      baseModel: 'upstream/x',
      sizeBytes: 12345,
      fetchedAt: 2000,
    });

    const loaded = loadCachedMetadata(db, 'a/b');
    expect(loaded?.dim).toBe(768);
    expect(loaded?.queryPrefix).toBe('new: ');
    expect(loaded?.prefixSource).toBe('metadata');
    expect(loaded?.baseModel).toBe('upstream/x');
    expect(loaded?.sizeBytes).toBe(12345);
    expect(loaded?.fetchedAt).toBe(2000);
  });

  // v1.7.5: TTL semantics removed; cache lives forever. The metadata cache
  // is invalidated explicitly via `obsidian-brain models refresh-cache`,
  // which calls `clearMetadataCache(db, modelId?)` below.

  it('clearMetadataCache (no model) nulls the v7 columns on every row', () => {
    upsertCachedMetadata(db, {
      modelId: 'a/b', dim: 384, maxTokens: 512,
      queryPrefix: 'q1: ', documentPrefix: '', prefixSource: 'metadata',
      baseModel: null, sizeBytes: 100, fetchedAt: 1000,
    });
    upsertCachedMetadata(db, {
      modelId: 'c/d', dim: 768, maxTokens: 8192,
      queryPrefix: 'q2: ', documentPrefix: '', prefixSource: 'readme',
      baseModel: null, sizeBytes: 200, fetchedAt: 2000,
    });

    const cleared = clearMetadataCache(db);
    expect(cleared).toBe(2);

    expect(loadCachedMetadata(db, 'a/b')).toBeNull();
    expect(loadCachedMetadata(db, 'c/d')).toBeNull();

    // The v6 capacity columns are preserved (advertised_max_tokens stays
    // populated; only v7 metadata columns get nulled).
    const v6Row = db.prepare(
      `SELECT advertised_max_tokens FROM embedder_capability WHERE embedder_id = ?`,
    ).get('a/b') as { advertised_max_tokens: number | null };
    expect(v6Row.advertised_max_tokens).toBe(512);
  });

  it('clearMetadataCache (with modelId) only nulls the matching row', () => {
    upsertCachedMetadata(db, {
      modelId: 'a/b', dim: 384, maxTokens: 512,
      queryPrefix: 'q1: ', documentPrefix: '', prefixSource: 'metadata',
      baseModel: null, sizeBytes: 100, fetchedAt: 1000,
    });
    upsertCachedMetadata(db, {
      modelId: 'c/d', dim: 768, maxTokens: 8192,
      queryPrefix: 'q2: ', documentPrefix: '', prefixSource: 'readme',
      baseModel: null, sizeBytes: 200, fetchedAt: 2000,
    });

    const cleared = clearMetadataCache(db, 'a/b');
    expect(cleared).toBe(1);

    expect(loadCachedMetadata(db, 'a/b')).toBeNull();
    expect(loadCachedMetadata(db, 'c/d')).not.toBeNull();
  });

  it('clearMetadataCache returns 0 when no rows match', () => {
    expect(clearMetadataCache(db)).toBe(0);
    expect(clearMetadataCache(db, 'never/seen')).toBe(0);
  });
});
