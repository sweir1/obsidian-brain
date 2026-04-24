#!/usr/bin/env node
/**
 * embedder-baseline.mjs
 *
 * Generates a stashed vector baseline for the 50-file fixture in
 * test/fixtures/embedder-v3-reference/. Each file is embedded with the
 * current default preset (Xenova/bge-small-en-v1.5, dtype q8) and the
 * resulting vectors are written to test/fixtures/embedder-v4-baseline.json.
 *
 * The JSON file is committed to the repo. The v4-equivalence test loads it
 * and asserts cosine similarity >= 0.9999 against freshly-computed vectors.
 * Any future @huggingface/transformers bump that shifts embeddings will cause
 * the test to fail, forcing investigation before shipping.
 *
 * Usage:
 *   npm run embedder:baseline
 *
 * Re-capture intentionally (e.g. after a deliberate model upgrade):
 *   npm run embedder:baseline
 *   git add test/fixtures/embedder-v4-baseline.json
 *   git commit -m "chore: re-capture embedder baseline after transformers upgrade"
 *
 * Environment variables honoured:
 *   TRANSFORMERS_CACHE / HF_HOME — passed through to transformers.js
 *   EMBEDDING_MODEL              — override model (default: Xenova/bge-small-en-v1.5)
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'embedder-v3-reference');
const OUTPUT_FILE = join(REPO_ROOT, 'test', 'fixtures', 'embedder-v4-baseline.json');

const MODEL = process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
const DTYPE = 'q8';
const TRANSFORMERS_VERSION = '4.2.0';
const CAPTURED_AT = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// ---------------------------------------------------------------------------
// Set up transformers.js cache the same way embedder.ts does.
// ---------------------------------------------------------------------------
const { pipeline, env: hfEnv } = await import('@huggingface/transformers');

const cacheOverride = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
if (cacheOverride) {
  hfEnv.cacheDir = cacheOverride;
}

// ---------------------------------------------------------------------------
// Load pipeline
// ---------------------------------------------------------------------------
console.log(`[baseline] Loading model: ${MODEL} (dtype=${DTYPE})`);
let extractor;
try {
  extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
} catch (err) {
  console.error(`[baseline] Failed to load model: ${err?.message ?? err}`);
  process.exit(1);
}

// Probe so we can print the output dimension.
const probeOut = await extractor(' ', { pooling: 'mean', normalize: true });
const probeVec = probeOut.tolist()[0];
console.log(`[baseline] Model loaded. Output dim: ${probeVec?.length ?? 'unknown'}`);

// ---------------------------------------------------------------------------
// Embed helper — serialised through a promise chain to avoid onnxruntime
// multi-call races (mirrors the TransformersEmbedder pattern).
// ---------------------------------------------------------------------------
let lastRun = Promise.resolve();

async function embed(text) {
  const inputText = text.trim() === '' ? ' ' : text; // guard for empty files
  const run = lastRun.then(() =>
    extractor(inputText, { pooling: 'mean', normalize: true }),
  );
  lastRun = run.then(() => undefined, () => undefined);
  const output = await run;
  return output.tolist()[0];
}

// ---------------------------------------------------------------------------
// Read fixture files and embed each one.
// ---------------------------------------------------------------------------
const entries = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.md')).sort();
console.log(`[baseline] Found ${entries.length} fixture files.`);

const vectors = {};
let idx = 0;
for (const filename of entries) {
  idx++;
  const filePath = join(FIXTURE_DIR, filename);
  const content = await readFile(filePath, 'utf-8');
  const vec = await embed(content);
  vectors[filename] = vec;
  if (idx % 10 === 0 || idx === entries.length) {
    console.log(`[baseline] Embedded ${idx}/${entries.length}: ${filename}`);
  }
}

// ---------------------------------------------------------------------------
// Dispose pipeline
// ---------------------------------------------------------------------------
if (typeof extractor.dispose === 'function') {
  await extractor.dispose();
}

// ---------------------------------------------------------------------------
// Write output JSON
// ---------------------------------------------------------------------------
const output = {
  model: MODEL,
  dtype: DTYPE,
  transformersVersion: TRANSFORMERS_VERSION,
  capturedAt: CAPTURED_AT,
  vectors,
};

await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf-8');
console.log(`[baseline] Wrote baseline to: ${OUTPUT_FILE}`);
console.log(`[baseline] Done. ${Object.keys(vectors).length} vectors captured.`);
