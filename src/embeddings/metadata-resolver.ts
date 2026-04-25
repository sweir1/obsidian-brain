/**
 * Layer 3 (v1.7.5): metadata resolution chain.
 *
 * Pure orchestration — all dependencies are injected so the chain is
 * exhaustively testable in isolation.
 *
 * Resolution order:
 *   1. embedder_capability cache hit, fresh (< 90 days) → return.
 *   2. Cache hit, stale (≥ 90d) → return cached AND fire-and-forget refetch.
 *   3. Cache miss + seed lookup hit → write seed row to cache, return.
 *   4. Cache miss + seed miss + HF live fetch (with timeout/retry) → cache, return.
 *   5. HF unreachable + embedder loaded → use embedder.dimensions(); 512 / symmetric.
 *   6. All fail → safe defaults + stderr warning. Boot continues.
 *
 * `OBSIDIAN_BRAIN_REFETCH_METADATA=1` forces step-4 even on a fresh cache hit.
 */

import type { DatabaseHandle } from '../store/db.js';
import type { Embedder } from './types.js';
import {
  type CachedMetadata,
  type CachedPrefixSource,
  loadCachedMetadata,
  upsertCachedMetadata,
  isStale,
  isForceRefetch,
} from './metadata-cache.js';
import { type SeedEntry, loadSeed } from './seed-loader.js';
import { getEmbeddingMetadata, type HfMetadata, type HfMetadataOptions } from './hf-metadata.js';

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
  resolvedFrom: 'cache-fresh' | 'cache-stale' | 'seed' | 'hf' | 'embedder-probe' | 'fallback';
}

export interface ResolverDeps {
  db: DatabaseHandle;
  /** Optional — when present, embedder.dimensions() is used as the
   *  step-5 fallback. Null is fine (e.g. CLI calls before embedder init). */
  embedder?: Embedder;
  /** Override the seed map (tests). Default: loadSeed(). */
  seed?: Map<string, SeedEntry>;
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
 */
export async function resolveModelMetadata(
  modelId: string,
  deps: ResolverDeps,
): Promise<ResolvedMetadata> {
  const env = deps.env ?? process.env;
  const seed = deps.seed ?? loadSeed();
  const fetchHf = deps.fetchHf ?? getEmbeddingMetadata;
  const force = isForceRefetch(env);

  // Step 1+2: cache check.
  const cached = loadCachedMetadata(deps.db, modelId);
  if (cached !== null && !force) {
    if (!isStale(cached)) {
      return materialise(cached, 'cache-fresh');
    }
    // Stale — return immediately AND fire async refetch (stale-while-revalidate).
    refetchInBackground(modelId, deps);
    return materialise(cached, 'cache-stale');
  }

  // Step 3: seed lookup.
  const seedEntry = seed.get(modelId);
  if (seedEntry) {
    const fromSeed = seedEntryToCached(modelId, seedEntry);
    upsertCachedMetadata(deps.db, fromSeed);
    return materialise(fromSeed, 'seed');
  }

  // Step 4: HF live fetch.
  try {
    const live = await fetchHf(modelId, { timeoutMs: deps.timeoutMs });
    const fromHf = hfMetadataToCached(live);
    upsertCachedMetadata(deps.db, fromHf);
    return materialise(fromHf, 'hf');
  } catch (err) {
    // Step 5: embedder probe fallback (zero-cost — model is already loaded).
    const reason = (err as Error).message ?? String(err);
    process.stderr.write(
      `obsidian-brain: metadata-resolver: HF fetch failed for ${modelId} (${reason.slice(0, 200)}); falling back\n`,
    );
    if (deps.embedder) {
      const probed = embedderProbeToCached(modelId, deps.embedder);
      upsertCachedMetadata(deps.db, probed);
      return materialise(probed, 'embedder-probe');
    }
    // Step 6: safe defaults.
    const fallback = safeDefaults(modelId);
    upsertCachedMetadata(deps.db, fallback);
    return materialise(fallback, 'fallback');
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
  deps: { db: DatabaseHandle; seed?: Map<string, SeedEntry> },
): ResolvedMetadata | null {
  const cached = loadCachedMetadata(deps.db, modelId);
  if (cached !== null && !isStale(cached)) {
    return materialise(cached, 'cache-fresh');
  }
  const seed = deps.seed ?? loadSeed();
  const seedEntry = seed.get(modelId);
  if (seedEntry) {
    const fromSeed = seedEntryToCached(modelId, seedEntry);
    upsertCachedMetadata(deps.db, fromSeed);
    return materialise(fromSeed, 'seed');
  }
  // Even a stale cache hit is more useful than null for bootstrap's prefix hash.
  if (cached !== null) {
    return materialise(cached, 'cache-stale');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function materialise(meta: CachedMetadata, resolvedFrom: ResolvedMetadata['resolvedFrom']): ResolvedMetadata {
  return {
    modelId: meta.modelId,
    dim: meta.dim,
    maxTokens: meta.maxTokens ?? FALLBACK_MAX_TOKENS,
    queryPrefix: meta.queryPrefix ?? '',
    documentPrefix: meta.documentPrefix ?? '',
    prefixSource: meta.prefixSource,
    baseModel: meta.baseModel,
    sizeBytes: meta.sizeBytes,
    resolvedFrom,
  };
}

function seedEntryToCached(modelId: string, entry: SeedEntry): CachedMetadata {
  return {
    modelId,
    dim: entry.dim,
    maxTokens: entry.maxTokens,
    queryPrefix: entry.queryPrefix,
    documentPrefix: entry.documentPrefix,
    // Seed entries are "from" the seed regardless of how the seed itself
    // sourced them upstream — we attribute the proximate source here so
    // index_status can report "this came from the bundled seed."
    prefixSource: 'seed',
    baseModel: entry.baseModel,
    sizeBytes: entry.sizeBytes,
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

/**
 * Stale-while-revalidate refetch. Fired and forgotten — never blocks the
 * caller, never throws past the catch boundary. Result lands in the cache
 * for the next boot.
 */
function refetchInBackground(modelId: string, deps: ResolverDeps): void {
  const fetchHf = deps.fetchHf ?? getEmbeddingMetadata;
  fetchHf(modelId, { timeoutMs: deps.timeoutMs })
    .then((live) => {
      upsertCachedMetadata(deps.db, hfMetadataToCached(live));
    })
    .catch((err) => {
      // Don't write to stderr on background-refresh failure — the user is
      // still operating off a stale-but-valid cache, no action required.
      // Surface only via debug logging if explicitly requested.
      if (deps.env?.OBSIDIAN_BRAIN_LOG_LEVEL === 'debug') {
        process.stderr.write(`obsidian-brain: metadata-resolver: background refetch for ${modelId} failed: ${(err as Error).message}\n`);
      }
    });
}
