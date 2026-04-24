/**
 * v4-equivalence.test.ts
 *
 * Retro-check: embeds all 50 files in test/fixtures/embedder-v3-reference/
 * with the current @huggingface/transformers runtime and asserts cosine
 * similarity >= COSINE_THRESHOLD (0.99) against the stashed baseline
 * vectors in test/fixtures/embedder-v4-baseline.json.
 *
 * Why 0.99 and not 0.9999:
 *   onnxruntime-node ships native per-platform binaries. macOS arm64 uses
 *   NEON + Apple Accelerate; Linux x86_64 uses AVX2/AVX-512 + OpenMP.
 *   Quantized (q8) inference is especially sensitive to this — int8→fp32
 *   dequant rounding, GEMM accumulation order (IEEE 754 float-add is
 *   non-associative), and softmax reductions all produce last-bit-
 *   different vectors across SIMD backends. Expected cross-platform drift
 *   is 0.997–0.999 cosine on non-trivial inputs. The q8 quantization
 *   itself already introduces ~0.001 cosine drift vs fp32 on a single
 *   platform, so cross-platform SIMD drift is of the same order as the
 *   quantization noise baked into the preset — invisible in top-K
 *   retrieval.
 *
 *   What 0.99 DOES catch: tokenizer breakage (0.3–0.7), pooling default
 *   shift (0.5–0.9), weight corruption (0.1–0.8), sign-flip / dim reorder
 *   (negative or ~0), wrong model loaded (~0.0). All real regressions
 *   drop well below 0.99; cross-platform SIMD noise sits comfortably
 *   above it.
 *
 * Running the test:
 *   npm test -- v4-equivalence     # runs by default
 *
 * The test requires the model (~34 MB for bge-small-en-v1.5, q8). CI caches
 * the HF dir across runs; locally the first run downloads it once. Set
 * OBSIDIAN_BRAIN_SKIP_BASELINE=1 to opt out explicitly (e.g. in an
 * offline environment).
 *
 * Re-capturing the baseline after an intentional model upgrade:
 *   npm run embedder:baseline
 *   git add test/fixtures/embedder-v4-baseline.json
 *   git commit -m "chore: re-capture embedder baseline after transformers upgrade"
 *
 * An `afterAll` also prints the drift floor for the run — a non-fatal
 * signal you can watch in CI logs to spot if drift trends downward over
 * time, which would indicate a silent library-level regression sneaking
 * in below the assertion threshold.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env as hfEnv } from '@huggingface/transformers';

// ---------------------------------------------------------------------------
// Skip flag: runs by default; opt out with OBSIDIAN_BRAIN_SKIP_BASELINE=1 for
// offline / constrained environments.
// ---------------------------------------------------------------------------
const runBaseline = process.env.OBSIDIAN_BRAIN_SKIP_BASELINE !== '1';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'embedder-v3-reference');
const BASELINE_FILE = join(REPO_ROOT, 'test', 'fixtures', 'embedder-v4-baseline.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface BaselineFile {
  model: string;
  dtype: string;
  transformersVersion: string;
  capturedAt: string;
  // Present on baselines captured v1.7.1+ — identifies the platform the
  // baseline was generated on so future debug can explain any drift.
  platform?: string;
  arch?: string;
  onnxruntimeVersion?: string;
  vectors: Record<string, number[]>;
}

// Cosine threshold — see the file header for the 0.99 vs 0.9999 rationale.
const COSINE_THRESHOLD = 0.99;

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// Diagnostic: show first 10 components of two vectors for debugging drift.
// ---------------------------------------------------------------------------
function vectorDiagnostic(filename: string, live: number[], ref: number[]): string {
  const n = Math.min(10, live.length, ref.length);
  const liveStr = live.slice(0, n).map((v) => v.toFixed(6)).join(', ');
  const refStr = ref.slice(0, n).map((v) => v.toFixed(6)).join(', ');
  return (
    `\nVector diagnostic for "${filename}" (first ${n} of ${live.length} components):\n` +
    `  live: [${liveStr}]\n` +
    `  ref:  [${refStr}]\n` +
    `  diff: [${live.slice(0, n).map((v, i) => (v - ref[i]).toFixed(6)).join(', ')}]`
  );
}

// ---------------------------------------------------------------------------
// Pipeline singleton — created once, disposed after all tests.
// ---------------------------------------------------------------------------
let extractor: {
  (text: string, opts: { pooling: 'mean'; normalize: boolean }): Promise<{ tolist(): number[][] }>;
  dispose?: () => Promise<void>;
} | null = null;

let lastRun: Promise<void> = Promise.resolve();

async function embedText(text: string): Promise<number[]> {
  if (!extractor) throw new Error('Pipeline not initialised');
  const inputText = text.trim() === '' ? ' ' : text; // guard: empty files → single space
  const ex = extractor;
  const run = lastRun.then(() => ex(inputText, { pooling: 'mean', normalize: true }));
  lastRun = run.then(() => undefined, () => undefined);
  const output = await run;
  return output.tolist()[0] ?? [];
}

// ---------------------------------------------------------------------------
// The test suite — skipped unless EMBEDDER_BASELINE=1.
// ---------------------------------------------------------------------------
describe.skipIf(!runBaseline)('embedder v4 equivalence', () => {
  let baseline: BaselineFile;
  let fixtureFiles: string[];
  let minCosineObserved = Number.POSITIVE_INFINITY;
  let minCosineFilename: string | null = null;

  beforeAll(async () => {
    // Set up cache the same way embedder.ts does.
    const cacheOverride = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheOverride) {
      hfEnv.cacheDir = cacheOverride;
    }

    // Load baseline JSON.
    const raw = await readFile(BASELINE_FILE, 'utf-8');
    baseline = JSON.parse(raw) as BaselineFile;

    // Load fixture file list.
    fixtureFiles = (await readdir(FIXTURE_DIR))
      .filter((f) => f.endsWith('.md'))
      .sort();

    // Initialise the pipeline with the same model+dtype as the baseline.
    extractor = (await pipeline('feature-extraction', baseline.model, {
      dtype: baseline.dtype as 'q8',
    })) as unknown as typeof extractor;

    // Probe to confirm the model loaded.
    const probe = await embedText(' ');
    if (!probe || probe.length === 0) {
      throw new Error('Pipeline probe returned empty vector — model may not have loaded correctly.');
    }
  }, 180_000); // allow up to 3 min for model download + load

  afterAll(async () => {
    // Non-fatal drift-floor signal: report the minimum cosine observed this
    // run so maintainers can spot a downward trend over many CI runs (which
    // would indicate a silent library-level regression sneaking in under
    // the assertion threshold). Cross-platform SIMD drift lands around
    // 0.997–0.999 on non-trivial inputs; if this number starts drifting
    // toward 0.99 over successive runs, investigate before it red-lines.
    if (Number.isFinite(minCosineObserved)) {
      const platformTag = `${process.platform}/${process.arch}`;
      const baselineTag =
        baseline.platform && baseline.arch
          ? `${baseline.platform}/${baseline.arch}`
          : 'unknown';
      // eslint-disable-next-line no-console
      console.warn(
        `[v4-equivalence] drift floor: cos=${minCosineObserved.toFixed(6)} ` +
          `on ${minCosineFilename ?? '?'}. runtime=${platformTag}, baseline=${baselineTag}. ` +
          `Threshold=${COSINE_THRESHOLD}. Investigate if this trends downward over many CI runs.`,
      );
    }

    if (extractor?.dispose) {
      await extractor.dispose();
      extractor = null;
    }
  });

  it('baseline file covers all fixture files', () => {
    const baselineKeys = Object.keys(baseline.vectors).sort();
    const fixtureKeys = fixtureFiles.slice().sort();
    expect(baselineKeys).toEqual(fixtureKeys);
  });

  it('baseline model matches current preset', () => {
    // Soft check: baseline should have been captured with bge-small-en-v1.5.
    // If someone re-captures with a different model by mistake, this catches it.
    expect(baseline.model).toBe('Xenova/bge-small-en-v1.5');
    expect(baseline.dtype).toBe('q8');
  });

  // One test per fixture file — makes failures pinpoint which content type drifted.
  for (const filename of [
    '001-english-prose.md',
    '002-english-prose.md',
    '003-english-prose.md',
    '004-english-prose.md',
    '005-english-prose.md',
    '006-english-prose.md',
    '007-english-prose.md',
    '008-english-prose.md',
    '009-english-prose.md',
    '010-english-prose.md',
    '011-code-fence.md',
    '012-code-fence.md',
    '013-code-fence.md',
    '014-code-fence.md',
    '015-code-fence.md',
    '016-code-fence.md',
    '017-code-fence.md',
    '018-code-fence.md',
    '019-code-fence.md',
    '020-code-fence.md',
    '021-latex-math.md',
    '022-latex-math.md',
    '023-latex-math.md',
    '024-latex-math.md',
    '025-latex-math.md',
    '026-headings.md',
    '027-headings.md',
    '028-headings.md',
    '029-headings.md',
    '030-headings.md',
    '031-multilingual-japanese.md',
    '032-multilingual-arabic.md',
    '033-multilingual-russian.md',
    '034-multilingual-spanish.md',
    '035-multilingual-french.md',
    '036-markdown-table.md',
    '037-markdown-table.md',
    '038-markdown-table.md',
    '039-markdown-table.md',
    '040-markdown-table.md',
    '041-transliterated-arabic.md',
    '042-transliterated-arabic.md',
    '043-transliterated-arabic.md',
    '044-transliterated-arabic.md',
    '045-transliterated-arabic.md',
    '046-edge-empty.md',
    '047-edge-single-char.md',
    '048-edge-whitespace.md',
    '049-edge-single-emoji.md',
    '050-edge-mixed-rtl-ltr.md',
  ]) {
    it(`cosine >= ${COSINE_THRESHOLD} for ${filename}`, async () => {
      const content = await readFile(join(FIXTURE_DIR, filename), 'utf-8');
      const liveVec = await embedText(content);
      const refVec = baseline.vectors[filename];

      expect(refVec, `No baseline vector for ${filename}`).toBeDefined();

      const sim = cosineSimilarity(liveVec, refVec);

      if (sim < minCosineObserved) {
        minCosineObserved = sim;
        minCosineFilename = filename;
      }

      if (sim < COSINE_THRESHOLD) {
        // A drop below 0.99 is almost certainly a real library regression
        // (tokenizer / pooling / weights / sign-flip / dim reorder) — not
        // mere cross-platform SIMD noise. Emit a detailed diagnostic so
        // the maintainer can distinguish the failure mode.
        const diag = vectorDiagnostic(filename, liveVec, refVec);
        throw new Error(
          `Cosine similarity too low for "${filename}": ${sim.toFixed(8)} < ${COSINE_THRESHOLD}` +
          `\nThis is below the cross-platform SIMD noise floor (~0.997) — likely a real` +
          `\ntokenizer / pooling / weight regression in the @huggingface/transformers` +
          `\nruntime, not just platform drift. Investigate before shipping. If the change` +
          `\nis intentional, re-run:` +
          `\n  npm run embedder:baseline && git add test/fixtures/embedder-v4-baseline.json` +
          diag,
        );
      }

      expect(sim).toBeGreaterThanOrEqual(COSINE_THRESHOLD);
    }, 60_000);
  }
});
