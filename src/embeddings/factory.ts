import type { Embedder } from './types.js';
import { TransformersEmbedder } from './embedder.js';
import { OllamaEmbedder } from './ollama.js';
import { resolveEmbeddingModel, resolveEmbeddingProvider } from './presets.js';

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
 *
 * Model resolution (transformers provider):
 *   resolveEmbeddingModel() handles EMBEDDING_MODEL > EMBEDDING_PRESET > default.
 *   TransformersEmbedder's own DEFAULT_MODEL is left as MiniLM so that tests
 *   which construct TransformersEmbedder directly (without going through the
 *   factory) remain deterministic and don't depend on process.env state.
 */
export function createEmbedder(): Embedder {
  const provider = resolveEmbeddingProvider(process.env);
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
    const numCtxRaw = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
    const numCtx =
      numCtxRaw !== undefined && Number.isFinite(numCtxRaw) && numCtxRaw > 0
        ? numCtxRaw
        : undefined;
    return new OllamaEmbedder(url, model, expectedDim, numCtx);
  }
  if (provider === 'transformers') {
    // Always route through resolveEmbeddingModel so EMBEDDING_PRESET is honoured
    // and the default flips to bge-small-en-v1.5 (v1.5.2+).
    const model = resolveEmbeddingModel(process.env);
    return new TransformersEmbedder(model);
  }
  throw new Error(
    `Unknown EMBEDDING_PROVIDER='${provider}'. Supported: 'transformers' (default), 'ollama'.`,
  );
}
