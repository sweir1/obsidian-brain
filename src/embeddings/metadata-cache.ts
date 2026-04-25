/**
 * Layer 4 (v1.7.5): persistence for resolved embedding metadata.
 *
 * Reads / writes the schema-v7 columns on `embedder_capability`
 * (`dim`, `query_prefix`, `document_prefix`, `prefix_source`, `base_model`,
 * `size_bytes`, `fetched_at`).
 *
 * **Cache lifetime: forever, until explicit invalidation.** v1.7.5 originally
 * shipped a 90-day TTL with stale-while-revalidate; that was reverted before
 * promotion in favour of "cache once, never auto-refetch" semantics. Reasoning:
 * the fields we cache (dim, model_type, hidden_size, ONNX sizes) are immutable
 * for a given HF model id — HF doesn't allow rewriting a published revision.
 * The fields that CAN change post-publish (tokenizer_config corrections,
 * retroactively-added prompts) change rarely, and silently auto-refetching
 * burns HF API quota across the whole user base for negligible benefit.
 * Users invalidate explicitly when they need to via the
 * `obsidian-brain models refresh-cache` CLI command.
 *
 * SQL-only — does not call HF, does not load JSON, does not consult seed.
 * All higher-level orchestration lives in `metadata-resolver.ts` (Layer 3).
 */

import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../store/db.js';

/** Source markers persisted into `prefix_source`. */
export type CachedPrefixSource = 'override' | 'seed' | 'metadata' | 'metadata-base' | 'readme' | 'fallback' | 'none';

/** Shape stored in / loaded from the `embedder_capability` v7 columns. */
export interface CachedMetadata {
  modelId: string;
  dim: number | null;
  /** Resolved max tokens (from advertised_max_tokens column for v6 compat). */
  maxTokens: number | null;
  queryPrefix: string | null;
  documentPrefix: string | null;
  prefixSource: CachedPrefixSource;
  baseModel: string | null;
  sizeBytes: number | null;
  fetchedAt: number | null;
}

interface CacheRow {
  advertised_max_tokens: number | null;
  dim: number | null;
  query_prefix: string | null;
  document_prefix: string | null;
  prefix_source: string | null;
  base_model: string | null;
  size_bytes: number | null;
  fetched_at: number | null;
}

/**
 * Stable per-model hash. Forms the (embedder_id, model_hash) primary key
 * alongside `embedder_id` so model renames invalidate cleanly.
 */
function modelHash(modelId: string): string {
  return createHash('sha256').update(modelId).digest('hex').slice(0, 32);
}

/**
 * Load cached metadata for `modelId`, or null if absent / has no v7 columns
 * populated yet.
 */
export function loadCachedMetadata(db: DatabaseHandle, modelId: string): CachedMetadata | null {
  const hash = modelHash(modelId);
  const row = db
    .prepare(
      `SELECT advertised_max_tokens, dim, query_prefix, document_prefix,
              prefix_source, base_model, size_bytes, fetched_at
         FROM embedder_capability
        WHERE embedder_id = ? AND model_hash = ?`,
    )
    .get(modelId, hash) as CacheRow | undefined;

  if (!row) return null;
  // Treat "v6 row with no metadata-cache columns populated" as a miss so the
  // resolver re-fills it. fetched_at is the canonical "this was populated"
  // marker; v6 rows have it null.
  if (row.fetched_at === null) return null;

  const prefixSource = (row.prefix_source as CachedPrefixSource | null) ?? 'none';
  return {
    modelId,
    dim: row.dim,
    maxTokens: row.advertised_max_tokens,
    queryPrefix: row.query_prefix,
    documentPrefix: row.document_prefix,
    prefixSource,
    baseModel: row.base_model,
    sizeBytes: row.size_bytes,
    fetchedAt: row.fetched_at,
  };
}

/**
 * Persist metadata for `modelId`. Writes to v7 columns; preserves any
 * existing `discovered_max_tokens` / `discovered_at` / `method` from the v6
 * adaptive-capacity flow (we only INSERT-or-UPDATE the v7 fields).
 */
export function upsertCachedMetadata(db: DatabaseHandle, meta: CachedMetadata): void {
  const hash = modelHash(meta.modelId);
  const now = meta.fetchedAt ?? Date.now();
  db.prepare(
    `INSERT INTO embedder_capability (
       embedder_id, model_hash,
       advertised_max_tokens, discovered_max_tokens, discovered_at, method,
       dim, query_prefix, document_prefix, prefix_source, base_model, size_bytes, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(embedder_id, model_hash) DO UPDATE SET
       advertised_max_tokens = excluded.advertised_max_tokens,
       dim                   = excluded.dim,
       query_prefix          = excluded.query_prefix,
       document_prefix       = excluded.document_prefix,
       prefix_source         = excluded.prefix_source,
       base_model            = excluded.base_model,
       size_bytes            = excluded.size_bytes,
       fetched_at            = excluded.fetched_at`,
  ).run(
    meta.modelId,
    hash,
    meta.maxTokens,
    // Seed `discovered_max_tokens` to the advertised value on first write so
    // the v6 adaptive-capacity ratchet has a sensible starting point. The
    // ON CONFLICT branch leaves it unchanged on subsequent writes.
    meta.maxTokens,
    now,
    'metadata-cache',
    meta.dim,
    meta.queryPrefix,
    meta.documentPrefix,
    meta.prefixSource,
    meta.baseModel,
    meta.sizeBytes,
    now,
  );
}

/**
 * Invalidate cached metadata so the next resolver pass refetches from the
 * seed → HF chain. NULLs the v7 columns (dim, query_prefix, etc.) on the
 * matching row(s) but preserves v6 capacity columns (`advertised_max_tokens`,
 * `discovered_max_tokens`, `method`) — those track adaptive-capacity drift,
 * not metadata, and shouldn't be reset by a metadata refresh.
 *
 * Returns the number of rows touched. When `modelId` is omitted, clears
 * every entry; otherwise only the row for that exact `embedder_id`.
 *
 * Called by `obsidian-brain models refresh-cache [--model <id>]`.
 */
export function clearMetadataCache(db: DatabaseHandle, modelId?: string): number {
  const setColumns =
    `dim = NULL, query_prefix = NULL, document_prefix = NULL, ` +
    `prefix_source = NULL, base_model = NULL, size_bytes = NULL, fetched_at = NULL`;
  if (modelId) {
    const result = db.prepare(`UPDATE embedder_capability SET ${setColumns} WHERE embedder_id = ?`).run(modelId);
    return Number(result.changes);
  }
  const result = db.prepare(`UPDATE embedder_capability SET ${setColumns}`).run();
  return Number(result.changes);
}
