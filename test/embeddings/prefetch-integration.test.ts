/**
 * Integration test: actually download and probe a real HF model via
 * `prefetchModel`. No `vi.mock('@huggingface/transformers', …)` in this
 * file — that's intentional. Vitest hoists `vi.mock` to module scope so
 * it can't be un-mocked per test; the unit tests in `prefetch.test.ts`
 * need the mock to inject failure modes, so the real-model exercise
 * lives here in its own file.
 *
 * What this catches that the unit tests can't:
 *   - Real HF module shape (a transformers.js release that renames the
 *     pipeline factory or changes the return shape fails here first).
 *   - Real ONNX load + probe end-to-end (a bad Node-ABI / sqlite-vec /
 *     onnxruntime-node interaction fails here, not in isolation).
 *   - Real "exhaust retries + throw" behaviour against a real HF 404.
 *
 * Runs by default; opt out with OBSIDIAN_BRAIN_SKIP_BASELINE=1 (same flag
 * as v4-equivalence.test.ts since both tests share the `bge-small-en-v1.5`
 * HF cache entry — cache warm on the second test, <1 s per case).
 */

import { describe, it, expect } from 'vitest';
import { prefetchModel } from '../../src/embeddings/prefetch.js';

const runIntegration = process.env.OBSIDIAN_BRAIN_SKIP_BASELINE !== '1';

describe.skipIf(!runIntegration)('prefetchModel — real HF integration', () => {
  it(
    'downloads + probes Xenova/bge-small-en-v1.5 (dim=384, attempts>=1)',
    async () => {
      const result = await prefetchModel('Xenova/bge-small-en-v1.5', {
        backoffBaseMs: 0,
      });

      expect(result.model).toBe('Xenova/bge-small-en-v1.5');
      expect(result.dim).toBe(384);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.attempts).toBeLessThanOrEqual(3);
      expect(new Date(result.cachedAt).getTime()).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'rejects with attempts=maxAttempts when the model id does not exist',
    async () => {
      let caught: (Error & { attempts?: number }) | undefined;
      try {
        await prefetchModel(
          'Xenova/definitely-not-a-real-model-xyz-obsidian-brain',
          { maxAttempts: 2, backoffBaseMs: 0 },
        );
      } catch (err) {
        caught = err as Error & { attempts?: number };
      }

      expect(caught).toBeDefined();
      expect(caught?.attempts).toBe(2);
      // HF returns one of several error shapes for a missing model:
      // - "Unauthorized access to file: …" (current HF 2026 response)
      // - "404" / "not found" / "Could not locate"
      // - "Unable to get model file" (ONNX load phase)
      // All legitimate "exhausted retries against a real HF failure".
      expect(caught?.message).toMatch(
        /Unauthorized|404|not found|Could not locate|Unable to get model file/i,
      );
    },
    60_000,
  );
});
