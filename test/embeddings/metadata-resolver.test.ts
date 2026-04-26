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
  maxTokens: 512,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
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

  // -------------------------------------------------------------------------
  // Override layer (~/.config/obsidian-brain/model-overrides.json)
  // -------------------------------------------------------------------------

  it('override.maxTokens replaces the seed value, prefixSource flips to "override"', async () => {
    const seed = makeSeed({ 'seed/m': SEED_ENTRY });
    const overrides = new Map([['seed/m', { maxTokens: 8192 }]]);
    const result = await resolveModelMetadata('seed/m', {
      db, seed, overrides, fetchHf: vi.fn(),
    });
    expect(result.resolvedFrom).toBe('seed');
    expect(result.maxTokens).toBe(8192);
    expect(result.queryPrefix).toBe(SEED_ENTRY.queryPrefix);
    expect(result.prefixSource).toBe('override');
    expect(result.overrideApplied).toBe(true);
  });

  it('override.queryPrefix replaces only that field; documentPrefix falls through to seed', async () => {
    const seed = makeSeed({ 'seed/m': SEED_ENTRY });
    const overrides = new Map([['seed/m', { queryPrefix: 'CUSTOM: ' }]]);
    const result = await resolveModelMetadata('seed/m', {
      db, seed, overrides, fetchHf: vi.fn(),
    });
    expect(result.queryPrefix).toBe('CUSTOM: ');
    expect(result.documentPrefix).toBe(SEED_ENTRY.documentPrefix);
    expect(result.maxTokens).toBe(SEED_ENTRY.maxTokens);
    expect(result.overrideApplied).toBe(true);
  });

  it('override.queryPrefix=null explicitly clears the prefix (distinct from "not set")', async () => {
    const seed = makeSeed({ 'seed/m': SEED_ENTRY });
    const overrides = new Map([['seed/m', { queryPrefix: null }]]);
    const result = await resolveModelMetadata('seed/m', {
      db, seed, overrides, fetchHf: vi.fn(),
    });
    expect(result.queryPrefix).toBe(''); // null → '' in materialise
    expect(result.documentPrefix).toBe(SEED_ENTRY.documentPrefix);
    expect(result.overrideApplied).toBe(true);
  });

  it('no override → overrideApplied=false, prefixSource preserves the resolver step', async () => {
    const seed = makeSeed({ 'seed/m': SEED_ENTRY });
    const result = await resolveModelMetadata('seed/m', {
      db, seed, overrides: new Map(), fetchHf: vi.fn(),
    });
    expect(result.overrideApplied).toBe(false);
    expect(result.prefixSource).toBe('seed');
  });

  it('complete override (all 3 fields) short-circuits HF entirely (zero fetch calls)', async () => {
    const fetchHf = vi.fn();
    // Brand-new id, not in seed. Override fully specifies all 3 fields.
    const overrides = new Map([['user/added-model', {
      maxTokens: 4096,
      queryPrefix: 'Q: ',
      documentPrefix: 'D: ',
    }]]);
    const result = await resolveModelMetadata('user/added-model', {
      db, seed: makeSeed(), overrides, fetchHf,
    });
    // The 6-step chain says: cache miss → seed miss → would normally hit HF.
    // The Step-0 short-circuit fires because the override is complete.
    expect(result.maxTokens).toBe(4096);
    expect(result.queryPrefix).toBe('Q: ');
    expect(result.documentPrefix).toBe('D: ');
    expect(result.prefixSource).toBe('override');
    expect(fetchHf).not.toHaveBeenCalled();
  });

  it('partial override (only maxTokens) does NOT short-circuit; HF still runs', async () => {
    // The short-circuit only fires when ALL three fields are specified.
    // Partial overrides need cache/seed/HF to fill in the missing fields.
    const fetchHf = vi.fn().mockResolvedValue(hfStub({
      modelId: 'user/partial', queryPrefix: 'hf-q: ', documentPrefix: 'hf-d: ',
    }));
    const overrides = new Map([['user/partial', { maxTokens: 9999 }]]);
    const result = await resolveModelMetadata('user/partial', {
      db, seed: makeSeed(), overrides, fetchHf,
    });
    expect(fetchHf).toHaveBeenCalled();
    expect(result.maxTokens).toBe(9999); // override wins
    expect(result.queryPrefix).toBe('hf-q: '); // HF fills in
  });

  it('override applies on cache-hit path too (not just first-resolve)', async () => {
    upsertCachedMetadata(db, {
      modelId: 'cached/m',
      dim: 384,
      maxTokens: 256,
      queryPrefix: 'orig-q: ',
      documentPrefix: '',
      prefixSource: 'metadata',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const overrides = new Map([['cached/m', { queryPrefix: 'overridden: ' }]]);
    const result = await resolveModelMetadata('cached/m', {
      db, seed: makeSeed(), overrides, fetchHf: vi.fn(),
    });
    expect(result.resolvedFrom).toBe('cache');
    expect(result.queryPrefix).toBe('overridden: ');
    expect(result.overrideApplied).toBe(true);
  });

  // S1 (v1.7.19): pre-v1.7.5 installs and the embedder-probe-fallback path
  // both wrote rows with NULL prefixes that short-circuited every subsequent
  // boot at step 1, silently disabling asymmetric-model query prefixes. The
  // resolver now detects this case and promotes from the bundled seed.

  it('S1: stale null-prefix cache + seed has prefixes → seed wins, cache row rewritten', async () => {
    upsertCachedMetadata(db, {
      modelId: 'asym/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: null,
      documentPrefix: null,
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const seed = makeSeed({ 'asym/model': SEED_ENTRY });
    const result = await resolveModelMetadata('asym/model', {
      db, seed, fetchHf: vi.fn(),
    });
    expect(result.resolvedFrom).toBe('seed');
    expect(result.queryPrefix).toBe(SEED_ENTRY.queryPrefix);
    // Subsequent call now hits the rewritten cache row (no longer stale).
    const second = await resolveModelMetadata('asym/model', {
      db, seed, fetchHf: vi.fn(),
    });
    expect(second.resolvedFrom).toBe('cache');
    expect(second.queryPrefix).toBe(SEED_ENTRY.queryPrefix);
  });

  it('S1: stale null-prefix cache + seed missing → cache wins (no regression)', async () => {
    upsertCachedMetadata(db, {
      modelId: 'unknown/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: null,
      documentPrefix: null,
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const fetchHf = vi.fn();
    const result = await resolveModelMetadata('unknown/model', {
      db, seed: makeSeed(), fetchHf,
    });
    expect(result.resolvedFrom).toBe('cache');
    expect(result.queryPrefix).toBe('');
    expect(fetchHf).not.toHaveBeenCalled();
  });

  it('S1: cache row with non-null prefix is NOT promoted (only the stale shape triggers)', async () => {
    upsertCachedMetadata(db, {
      modelId: 'good/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: 'cached-q: ',
      documentPrefix: 'cached-d: ',
      prefixSource: 'metadata',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const seed = makeSeed({ 'good/model': SEED_ENTRY });
    const result = await resolveModelMetadata('good/model', {
      db, seed, fetchHf: vi.fn(),
    });
    expect(result.resolvedFrom).toBe('cache');
    expect(result.queryPrefix).toBe('cached-q: ');
  });

  it('S1: partial override on stale cache still applies (override layer overlays seed)', async () => {
    upsertCachedMetadata(db, {
      modelId: 'asym/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: null,
      documentPrefix: null,
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const seed = makeSeed({ 'asym/model': SEED_ENTRY });
    const overrides = new Map([['asym/model', { queryPrefix: 'user-override: ' }]]);
    const result = await resolveModelMetadata('asym/model', {
      db, seed, overrides, fetchHf: vi.fn(),
    });
    // Resolved row is the seed (bug fix), but user override stomps queryPrefix.
    expect(result.resolvedFrom).toBe('seed');
    expect(result.queryPrefix).toBe('user-override: ');
    expect(result.documentPrefix).toBe(SEED_ENTRY.documentPrefix);
    expect(result.overrideApplied).toBe(true);
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

  it('S1: stale null-prefix cache + seed has prefixes → seed wins on sync path', () => {
    upsertCachedMetadata(db, {
      modelId: 'asym/model',
      dim: 384,
      maxTokens: 512,
      queryPrefix: null,
      documentPrefix: null,
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
      fetchedAt: Date.now(),
    });
    const seed = makeSeed({ 'asym/model': SEED_ENTRY });
    const result = resolveModelMetadataSync('asym/model', { db, seed });
    expect(result?.resolvedFrom).toBe('seed');
    expect(result?.queryPrefix).toBe(SEED_ENTRY.queryPrefix);
  });
});
