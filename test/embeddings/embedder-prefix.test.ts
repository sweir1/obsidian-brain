/**
 * v1.7.5: the `getTransformersPrefix` family-pattern table has been deleted.
 * Prefix resolution now goes through the metadata-resolver chain
 * (cache → bundled seed → HF API → safe defaults). The integration test for
 * embedder + prefix is in `test/embeddings/embedder.test.ts` (covers the
 * setMetadata → embed() flow); the prefix-content tests for individual
 * model families are now folded into the seed JSON itself plus the
 * `hf-metadata.test.ts` mocked-fetch suite.
 *
 * This file remains as a placeholder so the test runner doesn't 404 anyone
 * who follows old PR comments to it. Net coverage for prefix correctness
 * is unchanged — just sourced from upstream HF configs instead of our
 * hand-curated table.
 */

import { describe, it, expect } from 'vitest';
import { TransformersEmbedder } from '../../src/embeddings/embedder.js';
import type { EmbedderMetadata } from '../../src/embeddings/types.js';

describe('TransformersEmbedder prefix application (v1.7.5+)', () => {
  it('embed() reads prefix from metadata set via setMetadata, not a hardcoded table', () => {
    const emb = new TransformersEmbedder('Xenova/bge-small-en-v1.5');
    const meta: EmbedderMetadata = {
      modelId: 'Xenova/bge-small-en-v1.5',
      dim: 384,
      maxTokens: 512,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      documentPrefix: '',
      prefixSource: 'seed',
      baseModel: null,
      sizeBytes: null,
    };
    emb.setMetadata(meta);
    expect(emb.getMetadata()).toEqual(meta);
  });

  it('setMetadata throws on model-id mismatch (programming-error guard)', () => {
    const emb = new TransformersEmbedder('Xenova/bge-small-en-v1.5');
    const wrongMeta: EmbedderMetadata = {
      modelId: 'BAAI/bge-base-en-v1.5',
      dim: 768,
      maxTokens: 512,
      queryPrefix: '',
      documentPrefix: '',
      prefixSource: 'seed',
      baseModel: null,
      sizeBytes: null,
    };
    expect(() => emb.setMetadata(wrongMeta)).toThrow(/model mismatch/i);
  });

  it('getMetadata returns null before setMetadata is called', () => {
    const emb = new TransformersEmbedder('Xenova/bge-small-en-v1.5');
    expect(emb.getMetadata()).toBeNull();
  });
});
