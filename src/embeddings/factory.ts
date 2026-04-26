import type { Embedder } from './types.js';
import { TransformersEmbedder } from './embedder.js';
import { OllamaEmbedder } from './ollama.js';
import { resolvePresetConfig } from './presets.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/factory.ts');

/**
 * Build the Embedder for the resolved (provider, model) pair.
 *
 * Single chokepoint: `resolvePresetConfig(process.env)` returns provider AND
 * model atomically — there is no path through this function where the two
 * can desync. (Pre-v1.7.8 the Ollama branch read EMBEDDING_MODEL on its own
 * and ignored EMBEDDING_PRESET, which is how `multilingual-ollama` silently
 * fell through to `nomic-embed-text` for users who set the preset.)
 *
 * Returns an Embedder that still needs `init()` called on it (same contract
 * as `new TransformersEmbedder()`); the caller's existing
 * ensureEmbedderReady/init sequence handles both providers uniformly.
 * For the Ollama path, `init()` probes the server once to populate
 * `dimensions()`, unless `OLLAMA_EMBEDDING_DIM` declared it up front.
 *
 * Note on `TransformersEmbedder`'s own DEFAULT_MODEL (`Xenova/all-MiniLM-L6-v2`):
 * intentionally left as MiniLM so tests that construct it directly (without
 * going through this factory) stay deterministic and don't depend on
 * process.env state. Production paths always come through here.
 */
export function createEmbedder(): Embedder {
  const cfg = resolvePresetConfig(process.env);

  if (cfg.provider === 'ollama') {
    const url = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
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
    return new OllamaEmbedder(url, cfg.model, expectedDim, numCtx);
  }

  if (cfg.provider === 'transformers') {
    return new TransformersEmbedder(cfg.model);
  }

  throw new Error(
    `Unknown EMBEDDING_PROVIDER='${cfg.provider}'. Supported: 'transformers' (default), 'ollama'.`,
  );
}
