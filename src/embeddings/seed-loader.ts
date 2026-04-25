/**
 * Layer 2 (v1.7.5): bundled-seed JSON loader.
 *
 * Reads `data/seed-models.json` (committed anchor; refreshed by
 * `scripts/build-seed.py` at release time) and exposes a typed Map for
 * O(1) lookups. Pure read; no DB; no fetch.
 *
 * **Schema v2** (current): three load-bearing fields per entry —
 * `maxTokens`, `queryPrefix`, `documentPrefix`. Everything else
 * (`dim`, `sizeBytes`, `prefixSource`, `modelType`, `baseModel`,
 * `hasDenseLayer`, `hasNormalize`, `runnableViaTransformersJs`) was dropped
 * because runtime probes `dim` from the loaded ONNX, and the rest is
 * informational. We also can't trust MTEB's curated `embed_dim` — verified
 * across the canonical presets, BAAI/bge-small-en-v1.5 has `embed_dim=512`
 * in MTEB but the actual model dim is 384.
 *
 * **Schema v1** (older anchors / pre-Python build script): superset shape
 * with all the cosmetic fields. Loaded transparently — the v1→v2 adapter
 * pulls the three fields we still care about and discards the rest.
 *
 * Bad shape / missing file → returns an empty map + writes a single stderr
 * warning. Resolver falls through to the live HF fetcher; we never crash.
 */

import { createRequire } from 'node:module';

export interface SeedEntry {
  /** Effective max input tokens (from MTEB-curated `max_tokens`). Always set. */
  maxTokens: number;
  /** Query-side prefix (sentence-transformer `prompts.query`), or null for symmetric. */
  queryPrefix: string | null;
  /** Document-side prefix; '' for asymmetric models that prepend to queries only. */
  documentPrefix: string | null;
}

/** v1 entry shape — superset of v2 plus cosmetic fields we now drop on read. */
interface SeedEntryV1 {
  dim?: number;
  maxTokens: number;
  queryPrefix: string | null;
  documentPrefix: string | null;
  prefixSource?: string;
  modelType?: string;
  baseModel?: string | null;
  hasDenseLayer?: boolean;
  hasNormalize?: boolean;
  sizeBytes?: number | null;
  runnableViaTransformersJs?: boolean;
}

/** Union type covering both schema versions; the $schemaVersion field
 *  selects which shape applies to each entry. */
interface SeedFile {
  $schemaVersion: number;
  $generatedAt?: number;
  $source?: string;
  $mtebRevision?: string;
  models: Record<string, SeedEntry | SeedEntryV1>;
}

const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([1, 2]);

let cached: Map<string, SeedEntry> | null = null;
let cachedMeta: { generatedAt: number; source: string | null; entries: number } | null = null;

function isValidEntry(entry: unknown): entry is SeedEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.maxTokens !== 'number' || !Number.isFinite(e.maxTokens) || e.maxTokens <= 0) return false;
  if (e.queryPrefix !== null && typeof e.queryPrefix !== 'string') return false;
  if (e.documentPrefix !== null && typeof e.documentPrefix !== 'string') return false;
  return true;
}

/**
 * Project a v1 seed entry down to the v2 shape — drops every field except
 * the load-bearing trio (`maxTokens`, `queryPrefix`, `documentPrefix`).
 *
 * Exported for tests because the committed anchor is always v2, so the
 * live `loadSeed()` path never exercises this adapter; without a direct
 * test, an accidental break would only surface when (a) someone restores
 * a v1 anchor by mistake, or (b) ships an older committed seed via a
 * cherry-pick. Direct unit coverage costs ~10 lines of test and makes
 * the back-compat branch genuinely tested rather than aspirational.
 */
export function _adaptV1Entry(entry: SeedEntryV1): SeedEntry {
  return {
    maxTokens: entry.maxTokens,
    queryPrefix: entry.queryPrefix,
    documentPrefix: entry.documentPrefix,
  };
}

/** Reset the in-process cache (tests). Production code never calls this. */
export function _resetSeedCache(): void {
  cached = null;
  cachedMeta = null;
}

/**
 * Load the seed JSON once per process. Subsequent calls hit the in-memory
 * cache. Empty map on any load failure.
 */
export function loadSeed(): Map<string, SeedEntry> {
  if (cached !== null) return cached;
  cached = new Map();

  let parsed: unknown;
  try {
    const req = createRequire(import.meta.url);
    parsed = req('../../data/seed-models.json');
  } catch (err) {
    process.stderr.write(
      `obsidian-brain: seed-loader: ${(err as Error).message ?? 'failed to load seed JSON'} — proceeding without seed (HF live fetch will populate cache)\n`,
    );
    return cached;
  }

  if (!parsed || typeof parsed !== 'object') {
    process.stderr.write('obsidian-brain: seed-loader: seed JSON has invalid shape — ignoring\n');
    return cached;
  }

  const file = parsed as Partial<SeedFile>;
  const version = file.$schemaVersion;
  if (typeof version !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    process.stderr.write(
      `obsidian-brain: seed-loader: seed JSON schema version ${version ?? '?'} is not supported (expected one of ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}) — ignoring\n`,
    );
    return cached;
  }

  if (!file.models || typeof file.models !== 'object') {
    process.stderr.write('obsidian-brain: seed-loader: seed JSON has no `models` object — ignoring\n');
    return cached;
  }

  let kept = 0;
  let dropped = 0;
  for (const [modelId, raw] of Object.entries(file.models)) {
    const entry = version === 1 ? _adaptV1Entry(raw as SeedEntryV1) : (raw as SeedEntry);
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
    source: file.$source ?? file.$mtebRevision ?? null,
    entries: kept,
  };
  return cached;
}

/** Diagnostic — exposed for `index_status` / CLI to surface freshness. */
export function getSeedMeta(): { generatedAt: number; source: string | null; entries: number } | null {
  if (cached === null) loadSeed();
  return cachedMeta;
}
