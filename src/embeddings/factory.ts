import type { Embedder } from './types.js';
import { TransformersEmbedder } from './embedder.js';
import { OllamaEmbedder } from './ollama.js';

/**
 * Build the Embedder indicated by `EMBEDDING_PROVIDER`. Default is
 * `transformers` (the v1.4.0 local sentence-transformers path — zero
 * setup). Set `EMBEDDING_PROVIDER=ollama` to route through a local
 * Ollama server instead.
 *
 * Returns an Embedder that still needs `init()` called on it (same
 * contract as `new TransformersEmbedder()`); the caller's existing
 * ensureEmbedderReady/init sequence handles both providers uniformly.
 * For the Ollama path, `init()` probes the server once to populate
 * `dimensions()`, unless `OLLAMA_EMBEDDING_DIM` declared it up front.
 */
export function createEmbedder(): Embedder {
  const provider = (process.env.EMBEDDING_PROVIDER ?? 'transformers').toLowerCase();
  if (provider === 'ollama') {
    const url = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
    const expectedDim = process.env.OLLAMA_EMBEDDING_DIM
      ? Number(process.env.OLLAMA_EMBEDDING_DIM)
      : undefined;
    if (expectedDim !== undefined && (!Number.isFinite(expectedDim) || expectedDim <= 0)) {
      throw new Error(
        `OLLAMA_EMBEDDING_DIM='${process.env.OLLAMA_EMBEDDING_DIM}' is not a positive number.`,
      );
    }
    return new OllamaEmbedder(url, model, expectedDim);
  }
  if (provider === 'transformers') {
    return new TransformersEmbedder();
  }
  throw new Error(
    `Unknown EMBEDDING_PROVIDER='${provider}'. Supported: 'transformers' (default), 'ollama'.`,
  );
}
