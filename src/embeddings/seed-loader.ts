/**
 * Layer 2 (v1.7.5): bundled-seed JSON loader.
 *
 * Reads `data/seed-models.json` (committed anchor; refreshed by
 * `scripts/build-seed.mjs` at release time) and exposes a typed Map for
 * O(1) lookups. Pure read; no DB; no fetch.
 *
 * Bad shape / missing file → returns an empty map + writes a single stderr
 * warning. Resolver falls through to the live HF fetcher; we never crash.
 */

import { createRequire } from 'node:module';

/** Source markers as serialised in the JSON. Same enum as Layer 1's PrefixSource. */
export type SeedPrefixSource = 'metadata' | 'metadata-base' | 'readme' | 'none';

export interface SeedEntry {
  /** Output embedding dim. */
  dim: number;
  /** Effective max input tokens (from layered HF config resolution). */
  maxTokens: number;
  /** Query-side prefix from `config_sentence_transformers.json`, or null for symmetric. */
  queryPrefix: string | null;
  /** Document-side prefix; '' for asymmetric models that prepend to queries only. */
  documentPrefix: string | null;
  /** Where the prefixes came from: 'metadata' (this repo) or 'metadata-base' (upstream). */
  prefixSource: SeedPrefixSource;
  /** transformers `model_type` (e.g. 'bert', 'xlm-roberta'). */
  modelType: string;
  /** Upstream `base_model:` from README YAML, or null. */
  baseModel: string | null;
  /** True if `modules.json` declares a Dense projection layer. */
  hasDenseLayer: boolean;
  /** True if `modules.json` declares a Normalize layer. */
  hasNormalize: boolean;
  /** Total bytes of the q8 ONNX variant + sidecar, or null if no ONNX directory. */
  sizeBytes: number | null;
  /** Computed at build time: ONNX exists AND total size ≤ 2 GB. Consumers can
   *  filter at use time without us pre-filtering at build time. */
  runnableViaTransformersJs: boolean;
}

interface SeedFile {
  $schemaVersion: number;
  $generatedAt: number;
  $mtebRevision?: string;
  models: Record<string, SeedEntry>;
}

const SUPPORTED_SCHEMA_VERSION = 1;

let cached: Map<string, SeedEntry> | null = null;
let cachedMeta: { generatedAt: number; mtebRevision: string | null; entries: number } | null = null;

/**
 * Validate a single entry's shape minimally. Strict enough to catch corruption,
 * permissive enough to accept future fields without breaking on old code.
 */
function isValidEntry(entry: unknown): entry is SeedEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.dim !== 'number') return false;
  if (typeof e.maxTokens !== 'number') return false;
  if (e.queryPrefix !== null && typeof e.queryPrefix !== 'string') return false;
  if (e.documentPrefix !== null && typeof e.documentPrefix !== 'string') return false;
  if (typeof e.modelType !== 'string') return false;
  return true;
}

/**
 * Reset the in-process cache. Tests use this to swap seed contents between
 * cases. Production code never calls it.
 */
export function _resetSeedCache(): void {
  cached = null;
  cachedMeta = null;
}

/**
 * Load the seed JSON once per process, return the typed Map. Subsequent
 * calls hit the in-memory cache. Empty map on any load failure.
 */
export function loadSeed(): Map<string, SeedEntry> {
  if (cached !== null) return cached;
  cached = new Map();

  let parsed: unknown;
  try {
    // Use createRequire so the JSON path resolves the same way at runtime
    // (from dist/) as at test time (from src/). The `data/` directory is
    // bundled into the npm tarball via package.json `files`.
    const req = createRequire(import.meta.url);
    parsed = req('../../data/seed-models.json');
  } catch (err) {
    process.stderr.write(`obsidian-brain: seed-loader: ${(err as Error).message ?? 'failed to load seed JSON'} — proceeding without seed (HF live fetch will populate cache)\n`);
    return cached;
  }

  if (!parsed || typeof parsed !== 'object') {
    process.stderr.write('obsidian-brain: seed-loader: seed JSON has invalid shape — ignoring\n');
    return cached;
  }

  const file = parsed as Partial<SeedFile>;
  if (file.$schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    process.stderr.write(
      `obsidian-brain: seed-loader: seed JSON schema version ${file.$schemaVersion ?? '?'} ` +
      `(expected ${SUPPORTED_SCHEMA_VERSION}) — ignoring\n`,
    );
    return cached;
  }

  if (!file.models || typeof file.models !== 'object') {
    process.stderr.write('obsidian-brain: seed-loader: seed JSON has no `models` object — ignoring\n');
    return cached;
  }

  let kept = 0;
  let dropped = 0;
  for (const [modelId, entry] of Object.entries(file.models)) {
    if (isValidEntry(entry)) {
      cached.set(modelId, entry);
      kept++;
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    process.stderr.write(`obsidian-brain: seed-loader: ${dropped} seed entries skipped due to invalid shape\n`);
  }

  cachedMeta = {
    generatedAt: file.$generatedAt ?? 0,
    mtebRevision: file.$mtebRevision ?? null,
    entries: kept,
  };
  return cached;
}

/**
 * Diagnostic — exposed for `index_status` / CLI to surface freshness.
 */
export function getSeedMeta(): { generatedAt: number; mtebRevision: string | null; entries: number } | null {
  if (cached === null) loadSeed();
  return cachedMeta;
}
