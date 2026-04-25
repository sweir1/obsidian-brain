/**
 * v1.7.5 Layer 1 — pure HF API client tests (mocked fetch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmbeddingMetadata, extractBaseModel } from '../../src/embeddings/hf-metadata.js';

/**
 * Build a fake fetch that returns canned responses keyed by URL substring.
 * Routes are tried longest-key-first (most specific wins). String values are
 * served as text; object values are JSON-stringified for text() and parsed
 * for json(). Returns 404 for any unmapped URL.
 */
function makeFetcher(routes: Record<string, unknown>): typeof fetch {
  const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [key, val] of entries) {
      if (u.includes(key)) {
        const isString = typeof val === 'string';
        return {
          ok: true,
          status: 200,
          json: async () => (isString ? null : val),
          text: async () => (isString ? (val as string) : JSON.stringify(val)),
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => null, text: async () => '' } as unknown as Response;
  }) as typeof fetch;
}

describe('extractBaseModel', () => {
  it('reads single-string base_model from YAML frontmatter', () => {
    const readme = `---
license: apache-2.0
base_model: BAAI/bge-small-en-v1.5
language: en
---

# Some Model
`;
    expect(extractBaseModel(readme)).toBe('BAAI/bge-small-en-v1.5');
  });

  it('reads list-form base_model', () => {
    const readme = `---
base_model:
  - mixedbread-ai/mxbai-embed-large-v1
---
`;
    expect(extractBaseModel(readme)).toBe('mixedbread-ai/mxbai-embed-large-v1');
  });

  it('returns null when frontmatter has no base_model', () => {
    const readme = `---
license: mit
---
`;
    expect(extractBaseModel(readme)).toBeNull();
  });

  it('returns null when no frontmatter present', () => {
    expect(extractBaseModel('# Just a heading')).toBeNull();
  });
});

describe('getEmbeddingMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns dim/maxTokens/prefixes for a BGE-style model with canonical prompts', async () => {
    const fetcher = makeFetcher({
      '/config.json': {
        hidden_size: 384,
        num_hidden_layers: 12,
        max_position_embeddings: 512,
        model_type: 'bert',
      },
      '/tokenizer_config.json': { model_max_length: 512 },
      '/sentence_bert_config.json': { max_seq_length: 512 },
      '/config_sentence_transformers.json': {
        prompts: { query: 'Represent this sentence for searching relevant passages: ', document: '' },
      },
      '/modules.json': [
        { idx: 0, name: 'transformer', path: '0_Transformer', type: 'sentence_transformers.models.Transformer' },
        { idx: 2, name: 'normalize', path: '2_Normalize', type: 'sentence_transformers.models.Normalize' },
      ],
    });

    const meta = await getEmbeddingMetadata('BAAI/bge-small-en-v1.5', { fetcher });
    expect(meta.modelId).toBe('BAAI/bge-small-en-v1.5');
    expect(meta.dim).toBe(384);
    expect(meta.maxTokens).toBe(512);
    expect(meta.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(meta.documentPrefix).toBe('');
    expect(meta.prefixSource).toBe('metadata');
    expect(meta.hasNormalize).toBe(true);
    expect(meta.hasDenseLayer).toBe(false);
  });

  it('reads Dense layer out_features as dim, overriding hidden_size', async () => {
    const fetcher = makeFetcher({
      '/config.json': { hidden_size: 384, max_position_embeddings: 512, model_type: 'bert' },
      '/sentence_bert_config.json': { max_seq_length: 512 },
      '/config_sentence_transformers.json': { prompts: { query: 'Q: ', document: '' } },
      '/modules.json': [
        { idx: 0, name: 't', path: '0_Transformer', type: 'sentence_transformers.models.Transformer' },
        { idx: 1, name: 'd', path: '1_Dense', type: 'sentence_transformers.models.Dense' },
      ],
      '/1_Dense/config.json': { in_features: 384, out_features: 1024 },
    });

    const meta = await getEmbeddingMetadata('MongoDB/mdbr-leaf-ir', { fetcher });
    expect(meta.dim).toBe(1024);
    expect(meta.hasDenseLayer).toBe(true);
  });

  it('falls through to upstream base_model for prompts when local repo lacks them', async () => {
    const fetcher = makeFetcher({
      // Direct model — has config but no prompts.
      'mdbr/resolve/main/config.json': { hidden_size: 1024, max_position_embeddings: 512, model_type: 'bert' },
      'mdbr/resolve/main/tokenizer_config.json': { model_max_length: 512 },
      'mdbr/resolve/main/sentence_bert_config.json': { max_seq_length: 512 },
      'mdbr/resolve/main/config_sentence_transformers.json': {},  // no prompts
      'mdbr/resolve/main/modules.json': [],
      'mdbr/resolve/main/README.md': '---\nbase_model: mxbai-ai/mxbai-embed-large-v1\n---\n',
      // Upstream — has prompts.
      'mxbai-embed-large-v1/resolve/main/config_sentence_transformers.json': {
        prompts: { query: 'Represent this sentence for searching relevant passages: ', document: '' },
      },
    });

    const meta = await getEmbeddingMetadata('mdbr', { fetcher });
    expect(meta.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(meta.prefixSource).toBe('metadata-base');
    expect(meta.baseModel).toBe('mxbai-ai/mxbai-embed-large-v1');
  });

  it('returns prefixSource=none when neither repo nor upstream has prompts', async () => {
    const fetcher = makeFetcher({
      '/config.json': { hidden_size: 768, max_position_embeddings: 512, model_type: 'bert' },
    });
    const meta = await getEmbeddingMetadata('some/symmetric-model', { fetcher });
    expect(meta.prefixSource).toBe('none');
    expect(meta.queryPrefix).toBeNull();
    expect(meta.documentPrefix).toBeNull();
  });

  it('throws cleanly when config.json is unreachable (404)', async () => {
    const fetcher = makeFetcher({});
    await expect(getEmbeddingMetadata('not/exist', { fetcher })).rejects.toThrow(/config\.json not reachable/);
  });

  it('throws cleanly on multimodal model (no scalar hidden_size)', async () => {
    const fetcher = makeFetcher({
      '/config.json': { model_type: 'clip', text_config: { hidden_size: 768 } },
    });
    await expect(getEmbeddingMetadata('multimodal/clip', { fetcher })).rejects.toThrow(/no scalar embedding dim/);
  });

  it('respects xlm-roberta -2 offset when falling through to max_position_embeddings', async () => {
    const fetcher = makeFetcher({
      '/config.json': { hidden_size: 768, max_position_embeddings: 514, model_type: 'xlm-roberta' },
    });
    const meta = await getEmbeddingMetadata('intfloat/multilingual-e5-base', { fetcher });
    expect(meta.maxTokens).toBe(512);
  });

  it('handles T5 (d_model) and GPT-2 (n_embd / n_positions) family field names', async () => {
    const fetcher = makeFetcher({
      '/config.json': { d_model: 768, n_positions: 1024, model_type: 't5', num_layers: 12 },
    });
    const meta = await getEmbeddingMetadata('some/t5-model', { fetcher });
    expect(meta.dim).toBe(768);
    expect(meta.maxTokens).toBe(1024);
  });
});
