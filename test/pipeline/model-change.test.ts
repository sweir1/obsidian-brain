/**
 * Regression tests for bootstrap model-change detection.
 *
 * Covers the full matrix of model/dim combos that can land in the DB at boot
 * time, including the partial-boot failure mode where a crashed reindex leaves
 * the metadata in an inconsistent state (same model name, wrong dim).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { setMetadata, getMetadata } from '../../src/store/metadata.js';
import { upsertNode } from '../../src/store/nodes.js';
import type { Embedder } from '../../src/embeddings/types.js';

/** Minimal stub embedder — bootstrap only reads identity + dim, never embeds. */
class StubEmbedder implements Embedder {
  constructor(
    private readonly _model: string,
    private readonly _dim: number,
    private readonly _provider: string = 'stub',
  ) {}
  async init(): Promise<void> { /* no-op */ }
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return this._provider; }
  async dispose(): Promise<void> { /* no-op */ }
}

/**
 * Seed the DB with embedding metadata as if a previous boot wrote it.
 * We call bootstrap() once to create the schema, then overwrite just the
 * metadata keys we care about so the DB looks exactly like the scenario we
 * want to test.
 */
function seedEmbeddingMetadata(
  db: DatabaseHandle,
  model: string,
  dim: number,
  provider: string = 'stub',
): void {
  // Use a matching embedder for the initial boot so schema is created cleanly.
  const initEmb = new StubEmbedder(model, dim, provider);
  bootstrap(db, initEmb);
  // Then overwrite the metadata keys to set up the exact seed state.
  setMetadata(db, 'embedding_model', model);
  setMetadata(db, 'embedding_dim', String(dim));
  setMetadata(db, 'embedder_provider', provider);
}

describe('model-change bootstrap scenarios', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ── Scenario A — clean model swap with different dim ──────────────────────

  it('A: clean model swap (different name + different dim) triggers reindex and updates metadata', () => {
    // Seed: old transformers.js model at 384d
    seedEmbeddingMetadata(db, 'Xenova/multilingual-e5-small', 384, 'transformers.js');

    // Boot: new Ollama embedder at 768d
    const newEmb = new StubEmbedder('ollama:nomic-embed-text', 768, 'ollama');
    const result = bootstrap(db, newEmb);

    expect(result.needsReindex).toBe(true);
    expect(
      result.reasons.some((r) =>
        r.includes('embedder changed: Xenova/multilingual-e5-small(384d) -> ollama:nomic-embed-text(768d)'),
      ),
    ).toBe(true);
    // Metadata updated to reflect new model.
    expect(getMetadata(db, 'embedding_model')).toBe('ollama:nomic-embed-text');
    expect(getMetadata(db, 'embedding_dim')).toBe('768');
  });

  // ── Scenario B — same model, dim changed (partial-boot regression) ────────

  it('B: partial-boot regression — same model name but stale dim triggers reindex', () => {
    // Seed: partial boot left the new model name but old dim from prior session.
    // embedding_model = 'ollama:nomic-embed-text' (written by partial boot)
    // embedding_dim   = 1024 (stale from previous mE5-large session)
    seedEmbeddingMetadata(db, 'ollama:nomic-embed-text', 1024, 'ollama');

    // Current embedder: same model name, reports actual dim 768.
    const emb = new StubEmbedder('ollama:nomic-embed-text', 768, 'ollama');
    const result = bootstrap(db, emb);

    expect(result.needsReindex).toBe(true);
    // The reason must show both sides with the SAME model name but different dims.
    const mismatchReason = result.reasons.find((r) =>
      r.includes('ollama:nomic-embed-text(1024d)') && r.includes('ollama:nomic-embed-text(768d)'),
    );
    expect(mismatchReason).toBeDefined();
    // Dim should be corrected in metadata.
    expect(getMetadata(db, 'embedding_dim')).toBe('768');
  });

  // ── Scenario C — same model, same dim ────────────────────────────────────

  it('C: same model + same dim → no reindex', () => {
    seedEmbeddingMetadata(db, 'Xenova/bge-small-en-v1.5', 384, 'transformers.js');

    const emb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384, 'transformers.js');
    const result = bootstrap(db, emb);

    expect(result.needsReindex).toBe(false);
    // No embedder-changed reason should appear.
    expect(result.reasons.every((r) => !r.includes('embedder changed'))).toBe(true);
  });

  // ── Scenario D — model present but chunks table empty (upgrade path) ──────

  it('D: metadata correct but chunks table empty (upgrade path) → reindex with "chunk table is empty" reason', () => {
    seedEmbeddingMetadata(db, 'Xenova/bge-small-en-v1.5', 384, 'transformers.js');

    // Insert a node so the "has nodes but no chunks" condition fires.
    upsertNode(db, { id: 'note.md', title: 'Note', content: 'body', frontmatter: {} });

    const emb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384, 'transformers.js');
    const result = bootstrap(db, emb);

    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('chunk table is empty'))).toBe(true);
  });

  // ── Scenario E — preset changed but model string identical ───────────────

  it('E: two presets that resolve to the same model string → no reindex', () => {
    // Both EMBEDDING_PRESET=fast and EMBEDDING_PRESET=balanced hypothetically
    // resolve to the same underlying model. Only the model string matters in
    // the DB — bootstrap never sees preset names.
    const model = 'Xenova/all-MiniLM-L6-v2';
    seedEmbeddingMetadata(db, model, 384, 'transformers.js');

    // "Different preset" but identical resolved model string.
    const emb = new StubEmbedder(model, 384, 'transformers.js');
    const result = bootstrap(db, emb);

    expect(result.needsReindex).toBe(false);
    expect(result.reasons.every((r) => !r.includes('embedder changed'))).toBe(true);
  });

  // ── Scenario F — provider swap: same model name but different dim ─────────

  it('F: provider swap (transformers.js bge-m3 → ollama:bge-m3) with name change triggers reindex', () => {
    // transformers.js stores the model as 'bge-m3' (no prefix).
    // Ollama stores it as 'ollama:bge-m3'.
    // Even if the dim happens to match (1024), the model-name mismatch fires.
    seedEmbeddingMetadata(db, 'bge-m3', 1024, 'transformers.js');

    // New boot: same underlying model but now via Ollama → different identifier.
    const emb = new StubEmbedder('ollama:bge-m3', 1024, 'ollama');
    const result = bootstrap(db, emb);

    expect(result.needsReindex).toBe(true);
    expect(
      result.reasons.some((r) =>
        r.includes('embedder changed') &&
        r.includes('bge-m3') &&
        r.includes('ollama:bge-m3'),
      ),
    ).toBe(true);
    // Model identifier updated.
    expect(getMetadata(db, 'embedding_model')).toBe('ollama:bge-m3');
  });
});
