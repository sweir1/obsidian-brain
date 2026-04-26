/**
 * Layer 3 (v1.7.5): metadata resolution chain.
 *
 * Pure orchestration — all dependencies are injected so the chain is
 * exhaustively testable in isolation.
 *
 * Resolution order (cache lives forever — see metadata-cache.ts header for
 * why; users explicitly invalidate via `obsidian-brain models refresh-cache`):
 *   1. embedder_capability cache hit → return immediately.
 *   2. Cache miss + seed lookup hit → write seed row to cache, return.
 *   3. Cache miss + seed miss + HF live fetch (with timeout/retry) → cache, return.
 *   4. HF unreachable + embedder loaded → use embedder.dimensions(); 512 / symmetric.
 *   5. All fail → safe defaults + stderr warning. Boot continues.
 */

import type { DatabaseHandle } from '../store/db.js';
import type { Embedder } from './types.js';
import {
  type CachedMetadata,
  type CachedPrefixSource,
  loadCachedMetadata,
  upsertCachedMetadata,
} from './metadata-cache.js';
import { type SeedEntry, loadSeed } from './seed-loader.js';
import { getEmbeddingMetadata, type HfMetadata, type HfMetadataOptions } from './hf-metadata.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/metadata-resolver.ts');
import { type ModelOverride, loadOverrides } from './overrides.js';

/** Resolved metadata returned by the chain. Always non-null — falls through to safe defaults. */
export interface ResolvedMetadata {
  modelId: string;
  dim: number | null;
  maxTokens: number;
  queryPrefix: string;
  documentPrefix: string;
  prefixSource: CachedPrefixSource;
  baseModel: string | null;
  sizeBytes: number | null;
  /** Which step of the chain produced this result. */
  resolvedFrom: 'cache' | 'seed' | 'hf' | 'embedder-probe' | 'fallback';
  /** True iff a user override (~/.config/obsidian-brain/model-overrides.json)
   *  patched any field on top of the resolved value. Surfaced for diagnostics. */
  overrideApplied: boolean;
}

export interface ResolverDeps {
  db: DatabaseHandle;
  /** Optional — when present, embedder.dimensions() is used as the
   *  step-5 fallback. Null is fine (e.g. CLI calls before embedder init). */
  embedder?: Embedder;
  /** Override the seed map (tests). Default: loadSeed(). */
  seed?: Map<string, SeedEntry>;
  /** Override the user-overrides map (tests). Default: loadOverrides(). */
  overrides?: Map<string, ModelOverride>;
  /** Override the HF fetcher (tests). Default: getEmbeddingMetadata. */
  fetchHf?: (modelId: string, opts?: HfMetadataOptions) => Promise<HfMetadata>;
  /** Override env (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Per-fetch timeout. Forwarded to Layer 1. */
  timeoutMs?: number;
}

/** Safe defaults when nothing is reachable. */
const FALLBACK_MAX_TOKENS = 512;

/**
 * Async path — full chain. Used at bootstrap time after `embedder.init()`,
 * by `IndexPipeline.refreshCapacity()`, and by `models check`.
 *
 * Cache is permanent (no TTL). Users invalidate explicitly via
 * `obsidian-brain models refresh-cache`.
 */
export async function resolveModelMetadata(
  modelId: string,
  deps: ResolverDeps,
): Promise<ResolvedMetadata> {
  const seed = deps.seed ?? loadSeed();
  const overrides = deps.overrides ?? loadOverrides();
  const override = overrides.get(modelId) ?? null;
  const fetchHf = deps.fetchHf ?? getEmbeddingMetadata;

  // Step 0 (NEW): complete-override short-circuit. When the user has set
  // ALL three load-bearing fields via `models add` / `models override`,
  // the override fully specifies the model's metadata — there is nothing
  // useful HF/seed/cache could add. Skip the chain entirely so a "models
  // add foo/exotic …" call doesn't trigger a futile HF round-trip.
  // Partial overrides still go through the full chain (so missing fields
  // can be patched in by HF/seed/cache).
  if (isCompleteOverride(override)) {
    const synthetic = overrideToCached(modelId, override);
    upsertCachedMetadata(deps.db, synthetic);
    return materialise(synthetic, 'cache', override);
  }

  // Step 1: cache hit (forever).
  const cached = loadCachedMetadata(deps.db, modelId);
  if (cached !== null) {
    const promoted = promoteFromSeedIfStale(cached, seed, deps.db);
    if (promoted) return materialise(promoted, 'seed', override);
    return materialise(cached, 'cache', override);
  }

  // Step 2: seed lookup.
  const seedEntry = seed.get(modelId);
  if (seedEntry) {
    const fromSeed = seedEntryToCached(modelId, seedEntry);
    upsertCachedMetadata(deps.db, fromSeed);
    return materialise(fromSeed, 'seed', override);
  }

  // Step 3: HF live fetch.
  try {
    const live = await fetchHf(modelId, { timeoutMs: deps.timeoutMs });
    const fromHf = hfMetadataToCached(live);
    upsertCachedMetadata(deps.db, fromHf);
    return materialise(fromHf, 'hf', override);
  } catch (err) {
    // Step 4: embedder probe fallback (zero-cost — model is already loaded).
    const reason = (err as Error).message ?? String(err);
    process.stderr.write(
      `obsidian-brain: metadata-resolver: HF fetch failed for ${modelId} (${reason.slice(0, 200)}); falling back\n`,
    );
    if (deps.embedder) {
      const probed = embedderProbeToCached(modelId, deps.embedder);
      upsertCachedMetadata(deps.db, probed);
      return materialise(probed, 'embedder-probe', override);
    }
    // Step 5: safe defaults.
    const fallback = safeDefaults(modelId);
    upsertCachedMetadata(deps.db, fallback);
    return materialise(fallback, 'fallback', override);
  }
}

/**
 * Sync path — cache + seed only. Used by `bootstrap.ts` for the prefix-strategy
 * hash, which must be synchronous. Returns null when neither cache nor seed
 * has the model — callers treat null as "skip the optimisation, no reindex
 * triggered."
 */
export function resolveModelMetadataSync(
  modelId: string,
  deps: { db: DatabaseHandle; seed?: Map<string, SeedEntry>; overrides?: Map<string, ModelOverride> },
): ResolvedMetadata | null {
  const overrides = deps.overrides ?? loadOverrides();
  const override = overrides.get(modelId) ?? null;
  const seed = deps.seed ?? loadSeed();
  const cached = loadCachedMetadata(deps.db, modelId);
  if (cached !== null) {
    const promoted = promoteFromSeedIfStale(cached, seed, deps.db);
    if (promoted) return materialise(promoted, 'seed', override);
    return materialise(cached, 'cache', override);
  }
  const seedEntry = seed.get(modelId);
  if (seedEntry) {
    const fromSeed = seedEntryToCached(modelId, seedEntry);
    upsertCachedMetadata(deps.db, fromSeed);
    return materialise(fromSeed, 'seed', override);
  }
  return null;
}

/**
 * Stale-cache promotion: pre-v1.7.5 installs and the embedder-probe-fallback
 * path both wrote rows with `query_prefix = NULL` and `document_prefix = NULL`.
 * Once such a row is in the cache, every subsequent boot short-circuits at
 * step 1 and skips the seed — meaning asymmetric models (BGE/E5/mdbr) embed
 * queries with no prefix, sending them to a different region of the latent
 * space than documents and producing near-zero or negative cosine scores.
 *
 * Detect this case by looking for both prefix columns being NULL while the
 * bundled seed has the model. When matched, write the seed row over the bad
 * cache row and return it so the caller materialises the corrected metadata.
 *
 * Returns null when no promotion is needed — leaves the cache row untouched.
 *
 * Override entries are protected by the `isCompleteOverride` short-circuit
 * earlier in the resolver. Partial overrides go through this path but the
 * `materialise` layer overlays user-set null prefixes on top, so a user who
 * has explicitly cleared their prefixes still gets the cleared value.
 */
function promoteFromSeedIfStale(
  cached: CachedMetadata,
  seed: Map<string, SeedEntry>,
  db: DatabaseHandle,
): CachedMetadata | null {
  if (cached.queryPrefix !== null || cached.documentPrefix !== null) return null;
  const seedEntry = seed.get(cached.modelId);
  if (!seedEntry) return null;
  const fromSeed = seedEntryToCached(cached.modelId, seedEntry);
  upsertCachedMetadata(db, fromSeed);
  return fromSeed;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function materialise(
  meta: CachedMetadata,
  resolvedFrom: ResolvedMetadata['resolvedFrom'],
  override: ModelOverride | null,
): ResolvedMetadata {
  // Override layer: a partial patch on top of the resolved value. Any
  // omitted field falls through to the cache/seed/HF/probe value below.
  // null prefix from the override is treated as "explicitly clear" —
  // distinguishable from undefined ("not specified").
  const baseMaxTokens = meta.maxTokens ?? FALLBACK_MAX_TOKENS;
  const baseQuery = meta.queryPrefix ?? '';
  const baseDocument = meta.documentPrefix ?? '';

  const overrideMaxTokens = override?.maxTokens;
  const overrideQuery = override && 'queryPrefix' in override ? (override.queryPrefix ?? '') : undefined;
  const overrideDocument = override && 'documentPrefix' in override ? (override.documentPrefix ?? '') : undefined;

  const overrideApplied =
    override !== null &&
    (overrideMaxTokens !== undefined || overrideQuery !== undefined || overrideDocument !== undefined);

  return {
    modelId: meta.modelId,
    dim: meta.dim,
    maxTokens: overrideMaxTokens ?? baseMaxTokens,
    queryPrefix: overrideQuery ?? baseQuery,
    documentPrefix: overrideDocument ?? baseDocument,
    // When ANY override field applied, attribute the prefix source to the
    // override layer. Cache + bootstrap prefix-strategy hash already
    // includes the resolved prefix, so a change here triggers re-embed.
    prefixSource: overrideApplied ? 'override' : meta.prefixSource,
    baseModel: meta.baseModel,
    sizeBytes: meta.sizeBytes,
    resolvedFrom,
    overrideApplied,
  };
}

/**
 * True iff a user override fully specifies all three load-bearing fields.
 * A complete override means we don't need cache / seed / HF for anything —
 * the user has supplied a self-contained metadata record.
 *
 * `'queryPrefix' in override` (rather than `override.queryPrefix !== undefined`)
 * is intentional: a user can explicitly set queryPrefix=null to clear the
 * prefix; `null` is a meaningful value distinct from "not specified."
 */
function isCompleteOverride(override: ModelOverride | null): override is Required<ModelOverride> {
  if (override === null) return false;
  if (override.maxTokens === undefined) return false;
  if (!('queryPrefix' in override)) return false;
  if (!('documentPrefix' in override)) return false;
  return true;
}

function overrideToCached(modelId: string, override: Required<ModelOverride>): CachedMetadata {
  return {
    modelId,
    dim: null,
    maxTokens: override.maxTokens,
    queryPrefix: override.queryPrefix,
    documentPrefix: override.documentPrefix,
    prefixSource: 'override',
    baseModel: null,
    sizeBytes: null,
    fetchedAt: Date.now(),
  };
}

function seedEntryToCached(modelId: string, entry: SeedEntry): CachedMetadata {
  return {
    modelId,
    // v2 seed dropped `dim` / `baseModel` / `sizeBytes` — runtime probes
    // dim from the loaded ONNX, and baseModel/sizeBytes are display-only.
    // The cache columns stay nullable so HF live-fetch entries still
    // populate them when those values matter.
    dim: null,
    maxTokens: entry.maxTokens,
    queryPrefix: entry.queryPrefix,
    documentPrefix: entry.documentPrefix,
    // Seed entries are attributed as "from the seed" regardless of how
    // MTEB sourced them upstream, so `index_status` can report
    // "this came from the bundled seed."
    prefixSource: 'seed',
    baseModel: null,
    sizeBytes: null,
    fetchedAt: Date.now(),
  };
}

function hfMetadataToCached(live: HfMetadata): CachedMetadata {
  return {
    modelId: live.modelId,
    dim: live.dim,
    maxTokens: live.maxTokens,
    queryPrefix: live.queryPrefix,
    documentPrefix: live.documentPrefix,
    prefixSource: live.prefixSource,
    baseModel: live.baseModel,
    sizeBytes: live.sizeBytes,
    fetchedAt: Date.now(),
  };
}

function embedderProbeToCached(modelId: string, embedder: Embedder): CachedMetadata {
  return {
    modelId,
    dim: embedder.dimensions(),
    maxTokens: FALLBACK_MAX_TOKENS,
    queryPrefix: null,
    documentPrefix: null,
    prefixSource: 'fallback',
    baseModel: null,
    sizeBytes: null,
    fetchedAt: Date.now(),
  };
}

function safeDefaults(modelId: string): CachedMetadata {
  return {
    modelId,
    dim: null,
    maxTokens: FALLBACK_MAX_TOKENS,
    queryPrefix: null,
    documentPrefix: null,
    prefixSource: 'fallback',
    baseModel: null,
    sizeBytes: null,
    fetchedAt: Date.now(),
  };
}

