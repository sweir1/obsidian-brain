/**
 * v1.7.5 Layer 3 — resolver chain priority tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import {
  resolveModelMetadata,
  resolveModelMetadataSync,
} from '../../src/embeddings/metadata-resolver.js';
import { upsertCachedMetadata } from '../../src/embeddings/metadata-cache.js';
import type { SeedEntry } from '../../src/embeddings/seed-loader.js';
import type { HfMetadata } from '../../src/embeddings/hf-metadata.js';
import type { Embedder } from '../../src/embeddings/types.js';

const SEED_ENTRY: SeedEntry = {
  dim: 384,
  maxTokens: 512,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  prefixSource: 'metadata',
  modelType: 'bert',
  baseModel: null,
  hasDenseLayer: false,
  hasNormalize: true,
  sizeBytes: 35200000,
  runnableViaTransformersJs: true,
};

function makeSeed(map: Record<string, SeedEntry> = {}): Map<string, SeedEntry> {
  return new Map(Object.entries(map));
}

function hfStub(overrides: Partial<HfMetadata> = {}): HfMetadata {
  return {
    modelId: 'live/model',
    modelType: 'bert',
    hiddenSize: 768,
    numLayers: 12,
    dim: 768,
    hasDenseLayer: false,
    hasNormalize: true,
    maxTokens: 1024,
    queryPrefix: 'live-q: ',
    documentPrefix: 'live-d: ',
    prefixSource: 'metadata',
    baseModel: null,
    sizeBytes: 99999,
    sources: {
      hadModulesJson: true,
      hadSentenceBertConfig: true,
      hadSentenceTransformersConfig: true,
      hadOnnxDir: true,
      maxTokensFrom: 'sentence_bert_config',
    },
    ...overrides,
  };
}

class StubEmbedder implements Embedder {
  constructor(private readonly _model: string, private readonly _dim: number = 384) {}
  async init(): Promise<void> {}
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return 'stub'; }
  async dispose(): Promise<void> {}
}

describe('resolveModelMetadata — async chain', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('step 1: cache hit is returned without consulting seed or HF (no TTL — cache lives forever)', async () => {
    const fetchHf = vi.fn();
    upsertCachedMetadata(db, {
      modelId: 'cached/model',
      dim: 1024,
      maxTokens: 8192,
      queryPrefix: 'q: ',
      documentPrefix: 'd: ',
      prefixSource: 'metadata',
      baseModel: null,
      sizeBytes: 100,
      fetchedAt: Date.now(),
    });

    const result = await resolveModelMetadata('cached/model', { db, seed: makeSeed(), fetchHf });
    expect(result.resolvedFrom).toBe('cache');
    expect(result.dim).toBe(1024);
    expect(fetchHf).not.toHaveBeenCalled();
  });

  it('step 1b: even very-old cache entries hit (no TTL — only the CLI invalidates)', async () => {
    const fetchHf = vi.fn();
    upsertCachedMetadata(db, {
      modelId: 'cached/model',
      dim: 1024,
      maxTokens: 8192,
      queryPrefix: 'q: ',
      documentPrefix: 'd: ',
      prefixSource: 'metadata',
      baseModel: null,
      sizeBytes: 100,
      fetchedAt: Date.now() - (10 * 365 * 24 * 60 * 60 * 1000), // 10 years old
    });
    const result = await resolveModelMetadata('cached/model', { db, seed: makeSeed(), fetchHf });
    expect(result.resolvedFrom).toBe('cache');
    expect(fetchHf).not.toHaveBeenCalled();
  });

  it('step 2: cache miss + seed hit copies seed into cache and returns', async () => {
    const fetchHf = vi.fn();
    const seed = makeSeed({ 'seed/model': SEED_ENTRY });
    const result = await resolveModelMetadata('seed/model', { db, seed, fetchHf });
    expect(result.resolvedFrom).toBe('seed');
    expect(result.queryPrefix).toBe(SEED_ENTRY.queryPrefix);
    expect(fetchHf).not.toHaveBeenCalled();
    // Subsequent call hits the cache, not the seed.
    const second = await resolveModelMetadata('seed/model', { db, seed, fetchHf });
    expect(second.resolvedFrom).toBe('cache');
  });

  it('step 3: cache miss + seed miss → live HF fetch + cache write', async () => {
    const fetchHf = vi.fn().mockResolvedValue(hfStub({ modelId: 'live/model' }));
    const result = await resolveModelMetadata('live/model', { db, seed: makeSeed(), fetchHf });
    expect(result.resolvedFrom).toBe('hf');
    expect(result.dim).toBe(768);
    expect(fetchHf).toHaveBeenCalledWith('live/model', expect.any(Object));
    // Subsequent call hits the freshly-warmed cache.
    const second = await resolveModelMetadata('live/model', { db, seed: makeSeed(), fetchHf });
    expect(second.resolvedFrom).toBe('cache');
  });

  it('step 4: HF fail + embedder loaded → embedder-probe fallback', async () => {
    const fetchHf = vi.fn().mockRejectedValue(new Error('network down'));
    const embedder = new StubEmbedder('byom/exotic', 256);
    const result = await resolveModelMetadata('byom/exotic', { db, seed: makeSeed(), fetchHf, embedder });
    expect(result.resolvedFrom).toBe('embedder-probe');
    expect(result.dim).toBe(256);
    expect(result.queryPrefix).toBe('');
    expect(result.documentPrefix).toBe('');
  });

  it('step 5: HF fail + no embedder → safe defaults', async () => {
    const fetchHf = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await resolveModelMetadata('byom/no-embedder', { db, seed: makeSeed(), fetchHf });
    expect(result.resolvedFrom).toBe('fallback');
    expect(result.maxTokens).toBe(512);
    expect(result.dim).toBeNull();
  });
});

describe('resolveModelMetadataSync — bootstrap-time path', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns cache hit synchronously when present', () => {
    upsertCachedMetadata(db, {
      modelId: 'cached/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: 'q: ',
      documentPrefix: 'd: ',
      prefixSource: 'seed',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const result = resolveModelMetadataSync('cached/model', { db, seed: new Map() });
    expect(result?.resolvedFrom).toBe('cache');
  });

  it('returns null when neither cache nor seed has the model', () => {
    expect(resolveModelMetadataSync('never/seen', { db, seed: new Map() })).toBeNull();
  });

  it('returns seed hit and warms the cache for next call', () => {
    const seed = makeSeed({ 'seed/model': SEED_ENTRY });
    const first = resolveModelMetadataSync('seed/model', { db, seed });
    expect(first?.resolvedFrom).toBe('seed');
    // Second call hits cache because the first warmed it.
    const second = resolveModelMetadataSync('seed/model', { db, seed: new Map() });
    expect(second?.resolvedFrom).toBe('cache');
  });
});
