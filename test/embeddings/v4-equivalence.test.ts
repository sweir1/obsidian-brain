/**
 * v4-equivalence.test.ts
 *
 * Retro-check: embeds all 50 files in test/fixtures/embedder-v3-reference/
 * with the current @huggingface/transformers runtime and asserts cosine
 * similarity >= 0.9999 against the stashed baseline vectors in
 * test/fixtures/embedder-v4-baseline.json (captured with transformers.js
 * 4.2.0, Xenova/bge-small-en-v1.5, dtype q8).
 *
 * Why this matters:
 *   v1.6.18 bumped @huggingface/transformers from 3.8.1 → 4.2.0. The v4
 *   pipeline() API is backwards-compatible, but "API-compatible" does NOT
 *   guarantee bit-identical embeddings. A quantization-path change,
 *   tokenizer drift, or pooling-default shift could silently alter vector
 *   values — producing subtly worse retrieval that users wouldn't notice.
 *
 *   This test catches any such regression introduced by a future
 *   transformers.js bump (v4.3, v5, etc.) before the release ships.
 *
 * Running the test:
 *   EMBEDDER_BASELINE=1 npm test -- v4-equivalence
 *
 * The test is SKIPPED by default (no EMBEDDER_BASELINE env var) so it does
 * not slow down the main suite or CI. It requires the model to be cached
 * locally (~34 MB for bge-small-en-v1.5, q8).
 *
 * Re-capturing the baseline after an intentional model upgrade:
 *   npm run embedder:baseline
 *   git add test/fixtures/embedder-v4-baseline.json
 *   git commit -m "chore: re-capture embedder baseline after transformers upgrade"
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env as hfEnv } from '@huggingface/transformers';

// ---------------------------------------------------------------------------
// Skip flag: only runs when EMBEDDER_BASELINE=1 is set.
// ---------------------------------------------------------------------------
const runBaseline = !!process.env.EMBEDDER_BASELINE;

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
  vectors: Record<string, number[]>;
}

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
    it(`cosine >= 0.9999 for ${filename}`, async () => {
      const content = await readFile(join(FIXTURE_DIR, filename), 'utf-8');
      const liveVec = await embedText(content);
      const refVec = baseline.vectors[filename];

      expect(refVec, `No baseline vector for ${filename}`).toBeDefined();

      const sim = cosineSimilarity(liveVec, refVec);

      if (sim < 0.9999) {
        // Emit a detailed diagnostic so the maintainer can distinguish
        // dimension-order shift, sign flip, or scalar drift.
        const diag = vectorDiagnostic(filename, liveVec, refVec);
        throw new Error(
          `Cosine similarity too low for "${filename}": ${sim.toFixed(8)} < 0.9999` +
          `\nThis likely means the @huggingface/transformers upgrade shifted embeddings.` +
          `\nInvestigate before shipping. If the change is intentional, re-run:` +
          `\n  npm run embedder:baseline && git add test/fixtures/embedder-v4-baseline.json` +
          diag,
        );
      }

      expect(sim).toBeGreaterThanOrEqual(0.9999);
    }, 60_000);
  }
});
