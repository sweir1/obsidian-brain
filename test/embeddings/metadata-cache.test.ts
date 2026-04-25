/**
 * v1.7.5 Layer 4 — `embedder_capability` v7-column persistence + 90d TTL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import {
  loadCachedMetadata,
  upsertCachedMetadata,
  isStale,
  isForceRefetch,
  METADATA_TTL_MS,
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

  it('isStale returns false within 90-day window', () => {
    const now = 1_000_000_000_000;
    const meta = {
      modelId: 'x',
      dim: 1,
      maxTokens: 1,
      queryPrefix: '',
      documentPrefix: '',
      prefixSource: 'seed' as const,
      baseModel: null,
      sizeBytes: null,
      fetchedAt: now - METADATA_TTL_MS + 1,
    };
    expect(isStale(meta, now)).toBe(false);
  });

  it('isStale returns true at and past 90-day boundary', () => {
    const now = 1_000_000_000_000;
    const meta = {
      modelId: 'x',
      dim: 1,
      maxTokens: 1,
      queryPrefix: '',
      documentPrefix: '',
      prefixSource: 'seed' as const,
      baseModel: null,
      sizeBytes: null,
      fetchedAt: now - METADATA_TTL_MS,
    };
    expect(isStale(meta, now)).toBe(true);
  });

  it('isStale returns true on null fetched_at (treats as never-fetched)', () => {
    const meta = {
      modelId: 'x',
      dim: 1,
      maxTokens: 1,
      queryPrefix: '',
      documentPrefix: '',
      prefixSource: 'seed' as const,
      baseModel: null,
      sizeBytes: null,
      fetchedAt: null,
    };
    expect(isStale(meta)).toBe(true);
  });

  it('isForceRefetch reads OBSIDIAN_BRAIN_REFETCH_METADATA correctly', () => {
    expect(isForceRefetch({})).toBe(false);
    expect(isForceRefetch({ OBSIDIAN_BRAIN_REFETCH_METADATA: '' })).toBe(false);
    expect(isForceRefetch({ OBSIDIAN_BRAIN_REFETCH_METADATA: '0' })).toBe(false);
    expect(isForceRefetch({ OBSIDIAN_BRAIN_REFETCH_METADATA: '1' })).toBe(true);
    expect(isForceRefetch({ OBSIDIAN_BRAIN_REFETCH_METADATA: 'true' })).toBe(true);
    expect(isForceRefetch({ OBSIDIAN_BRAIN_REFETCH_METADATA: 'TRUE' })).toBe(true);
  });
});
