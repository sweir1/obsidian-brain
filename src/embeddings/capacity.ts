import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../store/db.js';
import type { Embedder } from './types.js';
import { OllamaEmbedder } from './ollama.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Describes the token-budget and method used to discover it for a particular
 * embedder model. All callers should use `chunkBudgetChars` to size chunks.
 */
export interface EmbedderCapacity {
  advertisedMaxTokens: number;
  discoveredMaxTokens: number;
  /** Floor(0.9 × min(advertised, discovered)) — safe operating budget. */
  chunkBudgetTokens: number;
  /** chunkBudgetTokens × charsPerTokenEstimate — char limit for chunker. */
  chunkBudgetChars: number;
  method: 'tokenizer_config' | 'api_show' | 'probe' | 'manual' | 'fallback';
}

// ---------------------------------------------------------------------------
// v1.7.5: KNOWN_MAX_TOKENS table removed. The values that lived here are now
// authoritative on the bundled seed (`data/seed-models.json`) or fetched live
// from HF on cache miss. The resolver runs at bootstrap time and populates
// `embedder_capability.advertised_max_tokens` for getCapacity to read.
//
// The fallback path below reads `model_max_length` from a loaded
// TransformersEmbedder tokenizer when the cache is cold (e.g., tests that
// call getCapacity directly without going through context.ts bootstrap).
// ---------------------------------------------------------------------------

/**
 * Conservative chars-per-token estimate. We ship 2.5 across the board for
 * multilingual safety (English-only models average ~3.5 but 2.5 is never
 * unsafe).
 */
const CHARS_PER_TOKEN = 2.5;

/** Fallback advertised token limit when nothing can be determined. */
const FALLBACK_MAX_TOKENS = 512;

/**
 * Hard floor on `discovered_max_tokens`. v1.7.2 shipped an unfloored ratchet
 * (one freak chunk on a long note could halve the budget down to ~115),
 * cascading more chunks into "too long" → more ratcheting → runaway. Below
 * 256 tokens (~640 chars) embeddings produce single-sentence chunks that
 * destroy retrieval quality, so we never let the ratchet go lower. Each
 * full reindex pass also calls `resetDiscoveredCapacity` to wipe drift.
 */
export const MIN_DISCOVERED_TOKENS = 256;

// ---------------------------------------------------------------------------
// Embedder type narrowing
// ---------------------------------------------------------------------------

/** Interface for the underlying transformers.js pipeline tokenizer. */
interface TransformersTokenizer {
  model_max_length?: number;
}

/** Narrow shape of the transformers.js pipeline object we need. */
interface TransformersPipeline {
  tokenizer?: TransformersTokenizer;
}

/** Minimal interface we need from TransformersEmbedder beyond base Embedder. */
interface TransformersEmbedderLike extends Embedder {
  /** The loaded pipeline (may be null before init). */
  readonly _pipeline?: TransformersPipeline;
  // Older builds expose the extractor field instead.
  readonly extractor?: TransformersPipeline & {
    tokenizer?: TransformersTokenizer;
  };
}

function isTransformersEmbedder(e: Embedder): e is TransformersEmbedderLike {
  return e.providerName() === 'transformers.js';
}

// ---------------------------------------------------------------------------
// SHA-256 model hash — model name change invalidates cache entry
// ---------------------------------------------------------------------------

function modelHash(embedder: Embedder): string {
  return createHash('sha256').update(embedder.modelIdentifier()).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Tokenizer probe — transformers.js path
// ---------------------------------------------------------------------------

/**
 * Attempt to read `model_max_length` from the underlying transformers.js
 * pipeline tokenizer. The pipeline is exposed as `extractor` on the class
 * (private field, accessed via `as unknown as TransformersEmbedderLike`).
 *
 * Returns null when the field is absent or the value looks bogus (<=0 or
 * very large — some models set this to Number.MAX_SAFE_INTEGER as a
 * "no limit" sentinel).
 */
function readTransformersModelMaxLength(embedder: TransformersEmbedderLike): number | null {
  // The TransformersEmbedder stores the pipeline in `extractor`.
  const pipe = embedder.extractor ?? embedder._pipeline;
  if (!pipe) return null;
  const tok = pipe.tokenizer;
  if (!tok) return null;
  const raw = tok.model_max_length;
  if (typeof raw !== 'number' || raw <= 0) return null;
  // transformers.js sometimes sets model_max_length to INT32_MAX / UINT32_MAX
  // as a "no limit" sentinel. Treat values above 1M as "not useful".
  if (raw > 1_000_000) return null;
  return raw;
}

/**
 * Resolve the effective advertised token limit for a transformers.js model
 * from the loaded tokenizer. v1.7.5: the KNOWN_MAX_TOKENS override table is
 * gone — the metadata-resolver chain (cache → seed → HF) handles per-model
 * overrides authoritatively. This is purely the cache-miss fallback path.
 */
function resolveTransformersAdvertised(
  tokenizerValue: number | null,
): { advertised: number; method: EmbedderCapacity['method'] } {
  if (tokenizerValue !== null) {
    return { advertised: tokenizerValue, method: 'tokenizer_config' };
  }
  return { advertised: FALLBACK_MAX_TOKENS, method: 'fallback' };
}

// ---------------------------------------------------------------------------
// Ollama /api/show probe
// ---------------------------------------------------------------------------

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  parameters?: string;
  details?: Record<string, unknown>;
}

/**
 * Call Ollama's GET /api/show (POST with body) to discover the model's
 * context_length from model_info. Falls back to parsing `num_ctx` from
 * the modelfile parameters string.
 *
 * Returns null on any failure so the caller can fall back gracefully.
 */
async function fetchOllamaContextLength(
  baseUrl: string,
  modelName: string,
): Promise<{ tokens: number; method: EmbedderCapacity['method'] } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as OllamaShowResponse;

    // Primary: model_info keys ending in ".context_length"
    if (data.model_info && typeof data.model_info === 'object') {
      for (const [key, val] of Object.entries(data.model_info)) {
        if (key.endsWith('.context_length') && typeof val === 'number' && val > 0) {
          return { tokens: val, method: 'api_show' };
        }
      }
    }

    // Fallback: num_ctx in modelfile parameters string
    if (typeof data.parameters === 'string') {
      const m = /num_ctx\s+(\d+)/i.exec(data.parameters);
      if (m) {
        const n = Number(m[1]);
        if (n > 0) return { tokens: n, method: 'api_show' };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB cache helpers
// ---------------------------------------------------------------------------

interface CapabilityRow {
  advertised_max_tokens: number | null;
  discovered_max_tokens: number | null;
  method: string | null;
}

function loadCachedCapability(
  db: DatabaseHandle,
  embedderId: string,
  hash: string,
): CapabilityRow | null {
  const row = db
    .prepare(
      'SELECT advertised_max_tokens, discovered_max_tokens, method FROM embedder_capability WHERE embedder_id = ? AND model_hash = ?',
    )
    .get(embedderId, hash) as CapabilityRow | undefined;
  return row ?? null;
}

function upsertCapability(
  db: DatabaseHandle,
  embedderId: string,
  hash: string,
  advertised: number,
  discovered: number,
  method: string,
): void {
  db.prepare(
    `INSERT INTO embedder_capability (embedder_id, model_hash, advertised_max_tokens, discovered_max_tokens, discovered_at, method)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(embedder_id, model_hash) DO UPDATE SET
       advertised_max_tokens = excluded.advertised_max_tokens,
       discovered_max_tokens = excluded.discovered_max_tokens,
       discovered_at = excluded.discovered_at,
       method = excluded.method`,
  ).run(embedderId, hash, advertised, discovered, Date.now(), method);
}

// ---------------------------------------------------------------------------
// Budget computation
// ---------------------------------------------------------------------------

function computeBudget(
  advertised: number,
  discovered: number,
  method: EmbedderCapacity['method'],
): EmbedderCapacity {
  const chunkBudgetTokens = Math.floor(0.9 * Math.min(advertised, discovered));
  const chunkBudgetChars = Math.floor(chunkBudgetTokens * CHARS_PER_TOKEN);
  return { advertisedMaxTokens: advertised, discoveredMaxTokens: discovered, chunkBudgetTokens, chunkBudgetChars, method };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get (or probe + cache) the effective token capacity for the given embedder.
 *
 * - TransformersEmbedder: reads `model_max_length` from the loaded pipeline
 *   tokenizer, cross-checks against the KNOWN_MAX_TOKENS validation table.
 * - OllamaEmbedder: calls `/api/show` and reads `model_info[*.context_length]`.
 * - All results are stored in `embedder_capability` for fast subsequent reads.
 * - A positive `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS` env var overrides the
 *   discovered capacity with method='manual'.
 */
export async function getCapacity(
  db: DatabaseHandle,
  embedder: Embedder,
): Promise<EmbedderCapacity> {
  // Env-var override takes priority over everything.
  const envOverride = parseInt(process.env.OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS ?? '', 10);
  if (!isNaN(envOverride) && envOverride > 0) {
    return computeBudget(envOverride, envOverride, 'manual');
  }

  const embedderId = embedder.modelIdentifier();
  const hash = modelHash(embedder);

  // Cache hit.
  const cached = loadCachedCapability(db, embedderId, hash);
  if (cached !== null && cached.advertised_max_tokens !== null && cached.discovered_max_tokens !== null) {
    return computeBudget(
      cached.advertised_max_tokens,
      cached.discovered_max_tokens,
      (cached.method as EmbedderCapacity['method']) ?? 'fallback',
    );
  }

  // Probe.
  let advertised: number;
  let discovered: number;
  let method: EmbedderCapacity['method'];

  if (isTransformersEmbedder(embedder)) {
    const tokVal = readTransformersModelMaxLength(embedder);
    const resolved = resolveTransformersAdvertised(tokVal);
    advertised = resolved.advertised;
    discovered = advertised;
    method = resolved.method;
  } else if (embedder.providerName() === 'ollama') {
    // Extract model name from "ollama:<model>" identifier.
    const modelName = embedderId.replace(/^ollama:/, '');
    // instanceof narrows to OllamaEmbedder so baseUrl is type-safe; fall back
    // to env-var / default for any other Ollama-compatible embedder.
    const baseUrl =
      (embedder instanceof OllamaEmbedder ? embedder.baseUrl : undefined) ??
      process.env.OLLAMA_BASE_URL ??
      'http://localhost:11434';

    const result = await fetchOllamaContextLength(baseUrl, modelName);
    if (result !== null) {
      advertised = result.tokens;
      discovered = result.tokens;
      method = result.method;
    } else {
      advertised = FALLBACK_MAX_TOKENS;
      discovered = FALLBACK_MAX_TOKENS;
      method = 'fallback';
    }
  } else {
    advertised = FALLBACK_MAX_TOKENS;
    discovered = FALLBACK_MAX_TOKENS;
    method = 'fallback';
  }

  // Persist probe result.
  upsertCapability(db, embedderId, hash, advertised, discovered, method);

  return computeBudget(advertised, discovered, method);
}

/**
 * Reset the cached `discovered_max_tokens` back to `advertised_max_tokens` so
 * a fresh reindex pass starts from the model's full advertised limit and
 * doesn't inherit drift from a previous run. No-op if no row exists yet —
 * the next `getCapacity()` call will probe and insert.
 *
 * Called once at the top of `IndexPipeline.index()` (full-vault reindex).
 * Not called on `indexSingleNote()` — single-file indexing is too frequent
 * to take this hit on every keystroke.
 */
export function resetDiscoveredCapacity(db: DatabaseHandle, embedder: Embedder): void {
  const embedderId = embedder.modelIdentifier();
  const hash = modelHash(embedder);
  db.prepare(
    `UPDATE embedder_capability
       SET discovered_max_tokens = advertised_max_tokens,
           discovered_at = ?
     WHERE embedder_id = ? AND model_hash = ?`,
  ).run(Date.now(), embedderId, hash);
}

/**
 * Record a chunk that failed to embed. Called by the fault-tolerant indexer
 * (V1.7.0-Faulttol) — wired here so the schema and helper live in one place.
 */
export function recordFailedChunk(
  db: DatabaseHandle,
  chunkId: string,
  noteId: string,
  reason: string,
  errorMessage: string | null,
): void {
  db.prepare(
    `INSERT INTO failed_chunks (chunk_id, note_id, reason, error_message, failed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       reason = excluded.reason,
       error_message = excluded.error_message,
       failed_at = excluded.failed_at`,
  ).run(chunkId, noteId, reason, errorMessage ?? null, Date.now());
}

/**
 * Reduce the cached discovered_max_tokens for the embedder by recording
 * a lower bound inferred from a failed chunk's token count. The new
 * discovered value is halved relative to the failing token count so the
 * next index pass tries meaningfully smaller chunks.
 *
 * This is a one-way ratchet — we never increase the discovered bound via
 * this function.
 */
export function reduceDiscoveredMaxTokens(
  db: DatabaseHandle,
  embedder: Embedder,
  failedChunkTokenCount: number,
): void {
  const embedderId = embedder.modelIdentifier();
  const hash = modelHash(embedder);
  // Floor at min(MIN_DISCOVERED_TOKENS, advertised) — see the constant's
  // docstring. For models that advertise less than the floor (rare; e.g.,
  // a 128-token testing stub), clamp at advertised so we don't claim a
  // higher capacity than the model supports.
  const cached = loadCachedCapability(db, embedderId, hash);
  const advertised = cached?.advertised_max_tokens ?? FALLBACK_MAX_TOKENS;
  const floor = Math.min(MIN_DISCOVERED_TOKENS, advertised);
  const newDiscovered = Math.max(floor, Math.floor(failedChunkTokenCount / 2));

  db.prepare(
    `INSERT INTO embedder_capability (embedder_id, model_hash, advertised_max_tokens, discovered_max_tokens, discovered_at, method)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(embedder_id, model_hash) DO UPDATE SET
       discovered_max_tokens = MIN(COALESCE(discovered_max_tokens, ?), ?),
       discovered_at = excluded.discovered_at,
       method = excluded.method`,
  ).run(embedderId, hash, newDiscovered, newDiscovered, Date.now(), 'probe', newDiscovered, newDiscovered);
}
