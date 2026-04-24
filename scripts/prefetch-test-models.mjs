#!/usr/bin/env node
/**
 * Download the embedding models used by the test suite with aggressive
 * retries and file-integrity checks. Designed for CI: runs BEFORE vitest
 * so flaky HF downloads don't surface as cryptic Protobuf-parsing errors
 * inside a failing test suite.
 *
 * Contract:
 *   - Reads $TRANSFORMERS_CACHE (or falls back to the transformers.js
 *     default) so the cache directory matches what tests will read.
 *   - Downloads each model via @huggingface/transformers' own pipeline()
 *     call, so the on-disk layout is exactly what tests expect.
 *   - On corrupt-cache indicators (Protobuf parsing, Load-model failure,
 *     missing files, 0-byte ONNX files), wipes the model's cache
 *     subdirectory and retries with exponential backoff.
 *   - Exits non-zero with an actionable message if all retries fail.
 *
 * This is faster than pre-downloading via curl because it uses the same
 * network layer transformers.js uses, so any LFS / auth headers / CDN
 * quirks get exercised identically.
 *
 * Implementation note: delegates to the shared `prefetchModel` helper in
 * src/embeddings/prefetch.ts (compiled to dist/). Running via tsx so the
 * TypeScript source is used directly without a separate build step.
 */

// We import from the compiled TS helper via tsx (run with `tsx scripts/…`).
// Using a dynamic import so the file is ES-module compatible regardless of
// how Node resolves it.
const { prefetchModel } = await import('../src/embeddings/prefetch.ts');

const MODELS = [
  'Xenova/all-MiniLM-L6-v2',   // default in src/embeddings/embedder.ts — used by tests that instantiate `new Embedder()` directly
  'Xenova/bge-small-en-v1.5',  // current preset default — used by factory-routed callers
];

const MAX_ATTEMPTS = 4;

const { env: hfEnv } = await import('@huggingface/transformers');
const cacheRoot =
  process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
if (cacheRoot) {
  hfEnv.cacheDir = cacheRoot;
}

console.log(`[prefetch] transformers.js cache: ${hfEnv.cacheDir}`);

let allOk = true;
for (const modelId of MODELS) {
  try {
    const result = await prefetchModel(modelId, { maxAttempts: MAX_ATTEMPTS });
    console.log(
      `[prefetch] ${result.model}: loaded + probed (dim=${result.dim}) after ${result.attempts} attempt(s)`,
    );
  } catch (err) {
    const attempts = (err && typeof err === 'object' && 'attempts' in err)
      ? err.attempts
      : MAX_ATTEMPTS;
    console.error(
      `[prefetch] FATAL: ${modelId} failed after ${attempts} attempts: ${err?.message ?? err}`,
    );
    allOk = false;
  }
}

if (!allOk) {
  console.error('[prefetch] One or more models could not be downloaded. Aborting.');
  process.exit(1);
}

console.log('[prefetch] All models cached and probed successfully.');
