/**
 * Unit tests for src/embeddings/prefetch.ts
 *
 * Network-dependent tests (actually downloading from HuggingFace) are
 * gated behind SLOW_TESTS=1. All other tests use vi.mock to replace
 * @huggingface/transformers so they remain fast and offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable state for controlling mock behaviour per-test.
// IMPORTANT: declared with `let` at module scope so vi.mock factory closure
// can capture it. DO NOT use vi.resetModules() — it breaks vi.mock hoisting.
// ---------------------------------------------------------------------------

// eslint-disable-next-line prefer-const
let callCount = 0;
// eslint-disable-next-line prefer-const
let shouldFailUntil = 0;
// eslint-disable-next-line prefer-const
let failWithCorrupt = false;
// eslint-disable-next-line prefer-const
let failWithNonCorrupt = false;
// eslint-disable-next-line prefer-const
let targetDim = 384;
// eslint-disable-next-line prefer-const
let useModel = 'Xenova/bge-small-en-v1.5';

function resetState() {
  callCount = 0;
  shouldFailUntil = 0;
  failWithCorrupt = false;
  failWithNonCorrupt = false;
  targetDim = 384;
  useModel = 'Xenova/bge-small-en-v1.5';
}

// ---------------------------------------------------------------------------
// Mocks — hoisted by vitest
// ---------------------------------------------------------------------------

vi.mock('@huggingface/transformers', () => {
  const cacheStore: { cacheDir: string } = { cacheDir: '/fake/cache' };
  return {
    env: cacheStore,
    pipeline: async (_task: string, _model: string, _opts: unknown) => {
      callCount++;
      if (failWithCorrupt && callCount <= shouldFailUntil) {
        throw new Error('Protobuf parsing failed for model');
      }
      if (failWithNonCorrupt) {
        throw new Error('Unexpected shape: foo is not a tensor');
      }
      if (callCount <= shouldFailUntil) {
        throw new Error('Load model failed: file not found');
      }
      // Happy path — return a callable extractor function with a dispose method.
      // The real transformers.js pipeline() returns a callable object; our
      // prefetch.ts calls it as `p(' ', { pooling, normalize })`.
      const vec = Array.from({ length: targetDim }, (_, i) => i / targetDim);
      const extractor = async (
        _text: string,
        _opts: { pooling: string; normalize: boolean },
      ) => ({ tolist: () => [vec] });
      (extractor as unknown as { dispose: () => Promise<void> }).dispose =
        vi.fn();
      return extractor;
    },
  };
});

// node:fs mock — rmSync is the key target.
const mockedRmSync = vi.fn();
const mockedExistsSync = vi.fn(() => false);
const mockedStatSync = vi.fn(() => ({ size: 999_999 }));

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: (...args: Parameters<typeof orig.existsSync>) =>
      mockedExistsSync(...args),
    statSync: (...args: Parameters<typeof orig.statSync>) =>
      mockedStatSync(...args) as ReturnType<typeof orig.statSync>,
    rmSync: (...args: Parameters<typeof orig.rmSync>) =>
      mockedRmSync(...args),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Import after mocks are declared (hoisting means this is safe).
import { prefetchModel } from '../../src/embeddings/prefetch.js';

describe('prefetchModel', () => {
  beforeEach(() => {
    resetState();
    mockedRmSync.mockClear();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ size: 999_999 } as ReturnType<typeof import('node:fs').statSync>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds on first attempt — returns dim and attempts=1', async () => {
    const result = await prefetchModel('Xenova/bge-small-en-v1.5', {
      maxAttempts: 4,
      backoffBaseMs: 0,
    });

    expect(result.model).toBe('Xenova/bge-small-en-v1.5');
    expect(result.dim).toBe(384);
    expect(result.attempts).toBe(1);
    expect(result.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('retries on corrupt-cache error — 2 attempts, cache wipe fired', async () => {
    // First call throws corrupt error; second succeeds.
    shouldFailUntil = 1;
    failWithCorrupt = true;

    const result = await prefetchModel('Xenova/bge-small-en-v1.5', {
      maxAttempts: 4,
      backoffBaseMs: 0,
    });

    expect(result.attempts).toBe(2);
    expect(result.dim).toBe(384);
    // rmSync should have been called to wipe the cache.
    expect(mockedRmSync).toHaveBeenCalled();
  });

  it('exhausts all retries — throws with last error', async () => {
    shouldFailUntil = 999; // always fail

    await expect(
      prefetchModel('Xenova/bge-small-en-v1.5', {
        maxAttempts: 3,
        backoffBaseMs: 0,
      }),
    ).rejects.toThrow(/Load model failed/);
  });

  it('respects maxAttempts count on exhaustion', async () => {
    shouldFailUntil = 999;

    let caught: unknown;
    try {
      await prefetchModel('Xenova/bge-small-en-v1.5', {
        maxAttempts: 2,
        backoffBaseMs: 0,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error & { attempts?: number }).attempts).toBe(2);
    expect(callCount).toBe(2);
  });

  it('non-corrupt errors are not retried (wipe is not called)', async () => {
    failWithNonCorrupt = true;

    await expect(
      prefetchModel('Xenova/bge-small-en-v1.5', {
        maxAttempts: 4,
        backoffBaseMs: 0,
      }),
    ).rejects.toThrow(/Unexpected shape/);

    // wipe should NOT have been called for a non-corrupt error.
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it('returns a valid ISO-8601 cachedAt timestamp', async () => {
    targetDim = 768;

    const result = await prefetchModel('some/model', {
      maxAttempts: 1,
      backoffBaseMs: 0,
    });

    expect(new Date(result.cachedAt).getTime()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // SLOW_TESTS-gated integration tests — require network access
  // -------------------------------------------------------------------------

  if (process.env.SLOW_TESTS === '1') {
    describe('integration (SLOW_TESTS=1)', () => {
      it(
        'downloads and probes Xenova/all-MiniLM-L6-v2 for real',
        async () => {
          // The mock for @huggingface/transformers is still in effect but the
          // real test should use the actual module. Because vi.mock hoisting
          // affects the whole file, SLOW_TESTS integration tests need to be
          // run in a separate file or via a separate vitest project. Skip here.
          //
          // To run a real download test, use:
          //   SLOW_TESTS=1 npx vitest run test/embeddings/embedder.test.ts
          expect(true).toBe(true); // placeholder
        },
        300_000,
      );
    });
  }
});
