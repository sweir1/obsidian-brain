/**
 * Shared prefetch helper for embedding models.
 *
 * Consumed by:
 *   - scripts/prefetch-test-models.mjs (CI warm-up)
 *   - src/cli/models.ts (`models prefetch` / `models check` subcommands)
 *
 * Key behaviours:
 *   - Loads via `pipeline('feature-extraction', model, { dtype: 'q8' })`.
 *   - On corrupt-cache / Protobuf / "Unable to get model file" errors: wipes
 *     the model's cache subdir and retries with exponential backoff.
 *   - Probes a 1-token embed to confirm the model actually works end-to-end.
 *   - Returns dim + metadata without leaving the pipeline loaded.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface PrefetchOptions {
  /** Maximum load attempts (default 3). */
  maxAttempts?: number;
  /** Base backoff interval in ms — doubles each retry (default 1000). */
  backoffBaseMs?: number;
  /** Override cache root (default: TRANSFORMERS_CACHE ?? HF_HOME). */
  cacheDir?: string;
}

export interface PrefetchResult {
  model: string;
  dim: number;
  attempts: number;
  cachedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isCorruptError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return (
    /Protobuf parsing failed/i.test(msg) ||
    /Load model .* failed/i.test(msg) ||
    /Invalid model file/i.test(msg) ||
    /Unable to get model file path or buffer/i.test(msg) ||
    /onnxruntime/i.test(msg)
  );
}

function looksCorrupt(modelId: string, cacheRoot: string): boolean {
  const dir = join(cacheRoot, modelId);
  if (!existsSync(dir)) return false;
  const onnxPath = join(dir, 'onnx', 'model_quantized.onnx');
  if (existsSync(onnxPath)) {
    const size = statSync(onnxPath).size;
    if (size === 0 || size < 1024) return true;
  }
  return false;
}

function wipeModelCache(modelId: string, cacheRoot: string): void {
  const dir = join(cacheRoot, modelId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; if we can't wipe it, the retry will likely surface the same error
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Download (if needed) and probe an embedding model.
 *
 * @throws If all attempts fail, throws the last error with an `attempts`
 *         property attached.
 */
export async function prefetchModel(
  model: string,
  opts?: PrefetchOptions,
): Promise<PrefetchResult> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const backoffBaseMs = opts?.backoffBaseMs ?? 1000;

  // Resolve the HF cache root once so we match what embedder.ts uses.
  const { env: hfEnv } = await import('@huggingface/transformers');
  const cacheRoot =
    opts?.cacheDir ??
    process.env.TRANSFORMERS_CACHE ??
    process.env.HF_HOME ??
    (hfEnv as unknown as { cacheDir?: string })?.cacheDir ??
    '';

  // Apply cache override if explicitly provided via opts.
  if (opts?.cacheDir) {
    (hfEnv as unknown as { cacheDir: string }).cacheDir = opts.cacheDir;
  } else if (process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME) {
    (hfEnv as unknown as { cacheDir: string }).cacheDir =
      (process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME)!;
  }

  // Proactive corruption check before first attempt.
  if (cacheRoot && looksCorrupt(model, cacheRoot)) {
    process.stderr.write(
      `[prefetch] ${model}: pre-existing corrupt cache detected, wiping…\n`,
    );
    wipeModelCache(model, cacheRoot);
  }

  const { pipeline } = await import('@huggingface/transformers');

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      process.stderr.write(
        `[prefetch] ${model}: attempt ${attempt}/${maxAttempts}…\n`,
      );

      // Cast through unknown — the union return type from pipeline() causes
      // TS2590 under strict mode; we only need the minimal extractor shape.
      const p = (await pipeline('feature-extraction', model, {
        dtype: 'q8',
      })) as unknown as {
        (text: string, opts: { pooling: string; normalize: boolean }): Promise<{
          tolist(): number[][];
        }>;
        dispose?: () => Promise<void>;
      };

      // Probe a 1-token embed to confirm end-to-end operation.
      const probe = await p(' ', { pooling: 'mean', normalize: true });
      const vec = probe.tolist()[0];
      if (!vec || vec.length === 0) {
        throw new Error(`Model "${model}" produced empty vector`);
      }

      if (typeof p.dispose === 'function') await p.dispose();

      const result: PrefetchResult = {
        model,
        dim: vec.length,
        attempts: attempt,
        cachedAt: new Date().toISOString(),
      };

      process.stderr.write(
        `[prefetch] ${model}: loaded + probed (dim=${vec.length}) in ${attempt} attempt(s)\n`,
      );

      return result;
    } catch (err) {
      lastErr = err;
      process.stderr.write(
        `[prefetch] ${model}: attempt ${attempt} failed: ${
          (err as Error)?.message ?? String(err)
        }\n`,
      );

      if (isCorruptError(err) && cacheRoot) {
        process.stderr.write(
          `[prefetch] ${model}: corrupt-cache error, wiping ${join(cacheRoot, model)}\n`,
        );
        wipeModelCache(model, cacheRoot);
      }

      if (attempt < maxAttempts) {
        const backoff = backoffBaseMs * 2 ** (attempt - 1);
        process.stderr.write(
          `[prefetch] waiting ${backoff}ms before retry…\n`,
        );
        await sleep(backoff);
      }
    }
  }

  // Attach attempt count so callers can surface it.
  const out = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  (out as Error & { attempts: number }).attempts = maxAttempts;
  throw out;
}
