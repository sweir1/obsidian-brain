/**
 * v1.7.3 regression tests — adaptive-capacity floor + reset (F2).
 *
 * Pre-v1.7.3, `reduceDiscoveredMaxTokens` was an unfloored one-way ratchet:
 * a single freak chunk could halve the cached `discovered_max_tokens` down
 * to single sentences (the user observed 115 / 165 against 512-advertised
 * models), cascading more chunks into too-long failures.
 *
 * v1.7.3 introduces:
 *   - `MIN_DISCOVERED_TOKENS=256` floor — clamped to advertised for tinier
 *     models so we never claim more capacity than the model supports.
 *   - `resetDiscoveredCapacity()` — wipes drift back to advertised at the
 *     start of each full reindex.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import {
  getCapacity,
  reduceDiscoveredMaxTokens,
  resetDiscoveredCapacity,
  MIN_DISCOVERED_TOKENS,
} from '../../src/embeddings/capacity.js';
import type { Embedder } from '../../src/embeddings/types.js';

class StubEmbedder implements Embedder {
  constructor(
    private readonly _model: string,
    private readonly _dim: number = 384,
  ) {}
  async init(): Promise<void> {}
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return 'stub'; }
  async dispose(): Promise<void> {}
}

class TransformersStub extends StubEmbedder {
  readonly extractor: { tokenizer: { model_max_length: number } } | null;
  constructor(modelId: string, modelMaxLength: number | null) {
    super(modelId);
    this.extractor =
      modelMaxLength !== null ? { tokenizer: { model_max_length: modelMaxLength } } : null;
  }
  override providerName(): string { return 'transformers.js'; }
}

function openTestDb(): DatabaseHandle {
  const db = openDb(':memory:');
  bootstrap(db, new StubEmbedder('test/model'));
  return db;
}

function readDiscovered(db: DatabaseHandle, embedder: Embedder): number {
  return (db.prepare(
    'SELECT discovered_max_tokens AS d FROM embedder_capability WHERE embedder_id = ?',
  ).get(embedder.modelIdentifier()) as { d: number }).d;
}

describe('v1.7.3 capacity floor + reset', () => {
  let db: DatabaseHandle;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('MIN_DISCOVERED_TOKENS is exported as 256', () => {
    expect(MIN_DISCOVERED_TOKENS).toBe(256);
  });

  it('floor prevents runaway drift — repeated tiny failures cannot push below 256', async () => {
    const emb = new TransformersStub('Xenova/multilingual-e5-base', 512);
    await getCapacity(db, emb);

    // Simulate the user's runaway-drift scenario: many tiny "too long"
    // failures hammering the ratchet. Pre-v1.7.3 this drove discovered
    // down to 115. Post-v1.7.3, the floor stops it at 256.
    for (let i = 0; i < 10; i++) {
      reduceDiscoveredMaxTokens(db, emb, 200);
    }

    expect(readDiscovered(db, emb)).toBe(256);
  });

  it('floor adapts to small models — never exceeds advertised', async () => {
    const emb = new TransformersStub('test/tiny', 128);
    await getCapacity(db, emb);
    reduceDiscoveredMaxTokens(db, emb, 50);
    // Advertised is 128, floor is min(256, 128) = 128.
    expect(readDiscovered(db, emb)).toBe(128);
  });

  it('resetDiscoveredCapacity wipes drift back to advertised', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    await getCapacity(db, emb);

    // Drift down via a "legitimate" failure (large chunk, well above the floor).
    reduceDiscoveredMaxTokens(db, emb, 2000); // 2000/2 = 1000
    expect(readDiscovered(db, emb)).toBe(1000);

    // Reset wipes the drift.
    resetDiscoveredCapacity(db, emb);
    expect(readDiscovered(db, emb)).toBe(8192);
  });

  it('resetDiscoveredCapacity is a no-op when no row exists yet (safe to call before getCapacity)', () => {
    const emb = new StubEmbedder('test/uninit');
    expect(() => resetDiscoveredCapacity(db, emb)).not.toThrow();
    const row = db.prepare(
      'SELECT discovered_max_tokens AS d FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier());
    expect(row).toBeUndefined();
  });
});
