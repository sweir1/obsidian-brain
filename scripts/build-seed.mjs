#!/usr/bin/env node
/**
 * Build the bundled seed JSON at `data/seed-models.json` (v1.7.5+).
 *
 * Discovery: shallow-clones https://github.com/embeddings-benchmark/results
 * and walks each model's `model_meta.json` to enumerate text-only,
 * open-weights candidates. Per-model metadata is then fetched from HF via
 * `getEmbeddingMetadata` (Layer 1) — same code path used at runtime when
 * a BYOM model isn't in the seed. Concurrency capped at 8 parallel HF
 * fetches.
 *
 * Filter rules (v1.7.5):
 *   - open_weights !== false (drops Cohere/OpenAI/Voyage cloud models)
 *   - modalities text-only or unspecified (drops multimodal/vision/audio)
 *   - model_id excludes 'colbert' / late-interaction (single-vector only)
 *   - HF config.json must be reachable + have a scalar embedding dim
 *
 * Oversized models stay in the seed — they're useful reference metadata
 * for users who BYOM via Ollama / external runtime. Each entry gets a
 * `runnableViaTransformersJs` boolean (true iff ONNX dir present and
 * total ONNX size ≤ 2 GB) so consumers can filter at use time.
 *
 * Failure modes:
 *   - Cannot clone MTEB results → exit 1; CI step is non-fatal so the
 *     committed anchor seed ships.
 *   - Per-model HF fetch fails → log + skip that entry. Others proceed.
 *   - Output file write fails → exit 1.
 *
 * Local invocation: `npm run build:seed`. Requires `git` + node fetch.
 * First run takes ~5–15 minutes (MTEB clone + ~250 HF fetches at 8x
 * concurrency); subsequent runs reuse no state.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_FILE = join(REPO_ROOT, 'data', 'seed-models.json');
const RESULTS_REPO = 'https://github.com/embeddings-benchmark/results.git';
const CONCURRENCY = 8;
const MAX_TRANSFORMERS_JS_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const SCHEMA_VERSION = 1;

// Reuse the runtime fetcher — but Layer 1 is TS source, so import the
// compiled JS from dist/. Build must precede `npm run build:seed`.
const distHfMetadata = join(REPO_ROOT, 'dist', 'embeddings', 'hf-metadata.js');
if (!existsSync(distHfMetadata)) {
  console.error(`build-seed: ${distHfMetadata} not found — run 'npm run build' first`);
  process.exit(1);
}
const { getEmbeddingMetadata } = await import(distHfMetadata);

function isTextOnly(modalities) {
  if (modalities == null) return true;
  if (!Array.isArray(modalities)) return false;
  if (modalities.length === 0) return true;
  const banned = new Set(['image', 'audio', 'video']);
  return modalities.every((m) => !banned.has(m));
}

function isOpenWeights(ow) {
  return ow !== false && ow !== 0;
}

function looksLikeMultiVector(name) {
  return /colbert|late-interaction|multi-vec/i.test(name);
}

async function discoverModelIds() {
  const tmp = mkdtempSync(join(tmpdir(), 'mteb-seed-'));
  console.log(`build-seed: cloning ${RESULTS_REPO} (shallow) → ${tmp}`);
  try {
    execSync(`git clone --depth 1 --quiet ${RESULTS_REPO} ${tmp}`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`build-seed: clone failed: ${err.message ?? err}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  let revision;
  try {
    revision = execSync('git rev-parse --short HEAD', { cwd: tmp, encoding: 'utf8' }).trim();
  } catch {
    revision = 'unknown';
  }

  const resultsDir = join(tmp, 'results');
  const ids = new Set();
  let stats = { total: 0, droppedClosedWeights: 0, droppedMultimodal: 0, droppedMultiVector: 0 };

  for (const modelDir of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!modelDir.isDirectory()) continue;
    const modelPath = join(resultsDir, modelDir.name);
    for (const revDir of readdirSync(modelPath, { withFileTypes: true })) {
      if (!revDir.isDirectory()) continue;
      const metaPath = join(modelPath, revDir.name, 'model_meta.json');
      if (!existsSync(metaPath)) continue;
      let meta;
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        continue;
      }
      stats.total++;
      if (!meta.name) continue;
      if (!isOpenWeights(meta.open_weights)) {
        stats.droppedClosedWeights++;
        continue;
      }
      if (!isTextOnly(meta.modalities)) {
        stats.droppedMultimodal++;
        continue;
      }
      if (looksLikeMultiVector(meta.name)) {
        stats.droppedMultiVector++;
        continue;
      }
      ids.add(meta.name);
    }
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(
    `build-seed: discovered ${ids.size} candidates (total=${stats.total} ` +
    `closed=${stats.droppedClosedWeights} multimodal=${stats.droppedMultimodal} ` +
    `multi-vector=${stats.droppedMultiVector})`,
  );
  return { ids: [...ids].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), revision };
}

async function fetchOne(modelId) {
  try {
    const meta = await getEmbeddingMetadata(modelId, { timeoutMs: 10_000, retries: 2 });
    const runnable =
      meta.sources.hadOnnxDir &&
      meta.sizeBytes !== null &&
      meta.sizeBytes <= MAX_TRANSFORMERS_JS_BYTES;
    return [modelId, {
      dim: meta.dim,
      maxTokens: meta.maxTokens,
      queryPrefix: meta.queryPrefix,
      documentPrefix: meta.documentPrefix,
      prefixSource: meta.prefixSource,
      modelType: meta.modelType,
      baseModel: meta.baseModel,
      hasDenseLayer: meta.hasDenseLayer,
      hasNormalize: meta.hasNormalize,
      sizeBytes: meta.sizeBytes,
      runnableViaTransformersJs: runnable,
    }];
  } catch (err) {
    return [modelId, { error: err.message ?? String(err) }];
  }
}

/** Process `ids` with at most `concurrency` simultaneous in-flight fetches. */
async function fetchAll(ids, concurrency) {
  const results = new Map();
  let nextIdx = 0;
  let completed = 0;
  let dropped = 0;

  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= ids.length) break;
      const id = ids[i];
      const [, val] = await fetchOne(id);
      if (val.error) {
        dropped++;
        if (process.env.OBSIDIAN_BRAIN_LOG_LEVEL === 'debug') {
          console.warn(`build-seed: skipping ${id}: ${val.error.slice(0, 100)}`);
        }
      } else {
        results.set(id, val);
      }
      completed++;
      if (completed % 25 === 0) {
        console.log(`build-seed: ${completed}/${ids.length} (${dropped} dropped)`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`build-seed: fetched ${results.size}/${ids.length} (dropped ${dropped})`);
  return results;
}

async function main() {
  const { ids, revision } = await discoverModelIds();
  const fetched = await fetchAll(ids, CONCURRENCY);

  // Sort entries by id for stable diffs.
  const sortedEntries = [...fetched.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const models = Object.fromEntries(sortedEntries);

  const output = {
    $schemaVersion: SCHEMA_VERSION,
    $generatedAt: Date.now(),
    $mtebRevision: revision,
    $comment:
      'Generated by scripts/build-seed.mjs. Do not edit by hand — re-run ' +
      '`npm run build:seed` to refresh from MTEB + HF. The release workflow ' +
      'regenerates this file before publishing each version.',
    models,
  };

  const tmpFile = OUT_FILE + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  // Atomic rename so partial writes never leave a corrupt seed.
  execSync(`mv ${JSON.stringify(tmpFile)} ${JSON.stringify(OUT_FILE)}`);
  console.log(`build-seed: wrote ${Object.keys(models).length} models to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(`build-seed: fatal: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
