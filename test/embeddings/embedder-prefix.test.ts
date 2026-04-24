import { describe, it, expect } from 'vitest';
import { getTransformersPrefix } from '../../src/embeddings/embedder.js';

describe('getTransformersPrefix', () => {
  it.each([
    ['Xenova/all-MiniLM-L6-v2', 'query', ''],
    ['Xenova/all-MiniLM-L6-v2', 'document', ''],
    ['Xenova/bge-small-en-v1.5', 'query', 'Represent this sentence for searching relevant passages: '],
    ['Xenova/bge-small-en-v1.5', 'document', ''],
    ['Xenova/bge-base-en-v1.5', 'query', 'Represent this sentence for searching relevant passages: '],
    ['Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'query', ''],
    ['intfloat/e5-small-v2', 'query', 'query: '],
    ['intfloat/e5-small-v2', 'document', 'passage: '],
    ['intfloat/multilingual-e5-small', 'query', 'query: '],
    ['intfloat/multilingual-e5-large', 'document', 'passage: '],
    ['nomic-ai/nomic-embed-text-v1.5', 'query', 'search_query: '],
    ['nomic-ai/nomic-embed-text-v1.5', 'document', 'search_document: '],
    ['mixedbread-ai/mxbai-embed-large-v1', 'query', 'Represent this sentence for searching relevant passages: '],
    ['mixedbread-ai/mxbai-embed-large-v1', 'document', ''],
    // `||` short-circuit arm: matches `mixedbread` without `mxbai`.
    ['mixedbread/example-embed', 'query', 'Represent this sentence for searching relevant passages: '],
    ['Snowflake/snowflake-arctic-embed-m', 'query', 'Represent this sentence for searching relevant passages: '],
    ['Snowflake/snowflake-arctic-embed-m', 'document', ''],
    // Arctic v1 preserved (no "v2" in model id)
    ['Snowflake/snowflake-arctic-embed-l', 'query', 'Represent this sentence for searching relevant passages: '],
    // Arctic v2 — confirmed HF model card: uses short "query: " prefix
    ['Snowflake/snowflake-arctic-embed-l-v2.0', 'query', 'query: '],
    ['Snowflake/snowflake-arctic-embed-l-v2.0', 'document', ''],
    ['Snowflake/snowflake-arctic-embed-m-v2.0', 'query', 'query: '],
    ['Snowflake/snowflake-arctic-embed-m-v2.0', 'document', ''],
    // Jina v2 — symmetric model, explicitly empty for both task types
    ['Xenova/jina-embeddings-v2-small-en', 'query', ''],
    ['Xenova/jina-embeddings-v2-base-en', 'query', ''],
    ['Xenova/jina-embeddings-v2-base-en', 'document', ''],
    // GTE (unqualified) — symmetric model, explicitly empty for both task types
    ['thenlper/gte-small', 'query', ''],
    ['thenlper/gte-small', 'document', ''],
    // Qwen3 embedding — asymmetric: "Query: " on queries, empty on documents
    ['qwen3-embedding-0.6b', 'query', 'Query: '],
    ['qwen3-embedding-0.6b', 'document', ''],
  ])('maps %s + %s → %j', (model, task, expected) => {
    expect(getTransformersPrefix(model, task as 'query' | 'document')).toBe(expected);
  });

  it('is case-insensitive on model id', () => {
    expect(getTransformersPrefix('BGE-SMALL-EN-V1.5', 'query')).toContain('Represent');
  });
});
