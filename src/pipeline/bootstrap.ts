import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../store/db.js';
import {
  dropEmbeddingState,
  ensureEdgesTargetFragmentColumn,
  ensureVecTables,
  rebuildFullTextIndex,
  currentFtsTokenize,
  renameTargetFragmentToSubpath,
  createEmbedderCapabilityTable,
  createFailedChunksTable,
  ensureEmbedderCapabilityV7Columns,
  SCHEMA_VERSION,
} from '../store/db.js';
import { getMetadata, setMetadata } from '../store/metadata.js';
import { countChunks } from '../store/chunks.js';
import { allNodeIds } from '../store/nodes.js';
import type { Embedder } from './../embeddings/types.js';
import { loadCachedMetadata, upsertCachedMetadata } from '../embeddings/metadata-cache.js';
import { loadOverrides } from '../embeddings/overrides.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/pipeline/bootstrap.ts');

const EXPECTED_FTS_TOKENIZE = 'porter unicode61';

/**
 * Version that increments whenever the prefix table in getTransformersPrefix
 * changes. Folded into the hash so a prefix-table update forces a reindex
 * even if the prefix strings themselves are identical.
 */
const PREFIX_STRATEGY_VERSION = 2;

/**
 * Explicit schema-migration chain. Each entry is keyed by the version it
 * upgrades TO. Helpers must be idempotent (PRAGMA-guarded, NO-OP when the
 * target state already exists) so re-running them is always safe — this is
 * what lets the bootstrap loop play forward from any starting version AND
 * run the chain unconditionally as a belt-and-braces heal pass.
 *
 * Version-to-version data migrations (model change, empty chunks, FTS
 * tokenizer, prefix strategy) are NOT in this chain — they're detection-
 * based and force a reindex rather than ALTER TABLE. See bootstrap() body.
 *
 * To add a new migration: bump SCHEMA_VERSION in src/store/db.ts, write an
 * idempotent helper in the same file, and append an entry here. No other
 * plumbing required.
 */
const SCHEMA_MIGRATIONS: Array<{ to: number; apply: (db: DatabaseHandle) => void }> = [
  // v1 → v2 and v2 → v3 had no ALTER-TABLE changes (those were data
  // migrations handled by the empty-chunks / FTS / prefix-strategy detection
  // in bootstrap()). No entries for them here.
  { to: 4, apply: ensureEdgesTargetFragmentColumn },
  // v5: rename target_fragment → target_subpath to match the Obsidian
  // ecosystem's LinkCache.subpath / Dataview Link.subpath naming.
  { to: 5, apply: renameTargetFragmentToSubpath },
  // v6: add embedder_capability + failed_chunks tables for adaptive
  // capacity tracking and fault-tolerant chunk logging.
  {
    to: 6,
    apply: (db: DatabaseHandle) => {
      createEmbedderCapabilityTable(db);
      createFailedChunksTable(db);
    },
  },
  // v7 (v1.7.5): extend embedder_capability with metadata-cache columns
  // (dim, query_prefix, document_prefix, prefix_source, base_model,
  // size_bytes, fetched_at). Idempotent ALTER TABLE — nullable columns,
  // no data migration. `createEmbedderCapabilityTable` also fans out to
  // this helper, so re-running is safe.
  { to: 7, apply: ensureEmbedderCapabilityV7Columns },
];

/**
 * Compute a stable hash of the prefix strategy for the given embedder.
 * Returns '' for symmetric models or non-transformers providers (Ollama
 * handles prefix application per-call; we never need to reindex on its behalf).
 *
 * v1.7.5: prefixes are resolved by the metadata-resolver chain (cache →
 * seed → HF) and pushed onto the embedder via `setMetadata()` BEFORE
 * `bootstrap()` runs. We read them off `embedder.getMetadata()` here.
 * If metadata is unset (e.g., first boot with HF unreachable for a BYOM
 * model not in the seed), we return '' — the prefix-strategy reindex
 * trigger no-ops, and the next boot's resolver retry will pick up the
 * prefix and trigger the reindex then. Degraded but correct.
 */
function computePrefixStrategy(embedder: Embedder): string {
  // Ollama bypass intentionally NOT applied any more: we just empirically
  // confirmed Ollama does NOT auto-apply prefixes (`TEMPLATE {{ .Prompt }}`
  // verbatim pass-through; vectors differ by prefix as expected). Both
  // OllamaEmbedder and TransformersEmbedder now read prefixes from
  // `_metadata` — so changes (override / fetch-seed / Tier 3 update)
  // need to fire reindex for both providers, not just transformers.js.
  const meta = embedder.getMetadata?.();
  if (!meta) return '';
  const q = meta.queryPrefix;
  const d = meta.documentPrefix;
  if (!q && !d) return ''; // symmetric model — empty sentinel
  return createHash('sha256')
    .update(`${q}|${d}|v${PREFIX_STRATEGY_VERSION}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Outcome of a bootstrap check. `reasons` is a cumulative list — the
 * server prints them on stderr so users understand why a reindex kicked in.
 */
export interface BootstrapResult {
  needsReindex: boolean;
  reasons: string[];
}

/**
 * Validate schema + embedder compatibility on startup and queue any
 * automatic migrations. Runs BEFORE the first index call.
 *
 * Handles three cases:
 *   1. Brand-new DB: stamp metadata, no reindex.
 *   2. Model / dim change since last run: wipe embedding state + queue a
 *      full reindex so new vectors are written against the current model.
 *   3. v1.3.1 → v1.4.0 upgrade (chunks table empty but nodes present,
 *      or old FTS tokenizer): rebuild FTS in place + queue reindex so
 *      chunks_vec gets populated.
 */
export function bootstrap(db: DatabaseHandle, embedder: Embedder): BootstrapResult {
  const reasons: string[] = [];
  let needsReindex = false;
  const currentModel = embedder.modelIdentifier();
  const currentDim = embedder.dimensions();

  const storedModel = getMetadata(db, 'embedding_model');
  const storedDim = Number(getMetadata(db, 'embedding_dim') ?? 0);
  const storedSchema = Number(getMetadata(db, 'schema_version') ?? 0);

  // First-ever metadata-write. Could be brand-new (no nodes yet) OR a pre-
  // 1.4.0 install that never wrote metadata but already has nodes/FTS/
  // embeddings from v1.3.x. Stamp the identity either way — the chunk /
  // FTS migration checks below still run for the "nodes exist but no
  // metadata" case.
  if (!storedModel) {
    ensureVecTables(db, currentDim);
    setMetadata(db, 'embedding_model', currentModel);
    setMetadata(db, 'embedding_dim', String(currentDim));
    setMetadata(db, 'schema_version', String(SCHEMA_VERSION));
    setMetadata(db, 'embedder_provider', embedder.providerName());
    // Fall through to the FTS / chunks migration checks so pre-1.4.0
    // installations upgrade cleanly.
  } else if (storedModel !== currentModel || storedDim !== currentDim) {
    // Model or dim change. Drop everything embedded against the old model
    // and queue a full reindex so the new vectors line up.
    reasons.push(
      `embedder changed: ${storedModel}(${storedDim}d) -> ${currentModel}(${currentDim}d)`,
    );
    needsReindex = true;
    dropEmbeddingState(db);
    ensureVecTables(db, currentDim);
    setMetadata(db, 'embedding_model', currentModel);
    setMetadata(db, 'embedding_dim', String(currentDim));
    setMetadata(db, 'embedder_provider', embedder.providerName());
  } else {
    // Dim unchanged but tables may still be missing (fresh DB that has
    // nodes via some other path, tests, etc.). Cheap to reconcile.
    ensureVecTables(db, currentDim);
  }

  // Identity-hash check: catches the silent-tag-update footgun where the
  // bare model id is unchanged (e.g. `ollama:bge-m3` before and after
  // `ollama pull bge-m3`) but the underlying weights swapped. OllamaEmbedder
  // returns the manifest digest from `/api/tags`; TransformersEmbedder
  // returns null (HF revisions are normally pinned by-commit, much rarer
  // to silently change).
  //
  // Semantics:
  //   - storedHash absent + currentHash null: legacy install or non-Ollama
  //     embedder — skip and don't stamp (nothing to track).
  //   - storedHash absent + currentHash set: first time we tracked it —
  //     stamp without reindexing (we don't know whether existing vectors
  //     were built under the same hash; assume they were).
  //   - storedHash set + currentHash null: Ollama unreachable at init —
  //     skip the comparison, leave the stamp alone. No spurious reindex.
  //   - storedHash set + currentHash set + equal: no-op.
  //   - storedHash set + currentHash set + differ: weights swapped under
  //     us — wipe + reindex, stamp the new hash.
  const storedHash = getMetadata(db, 'embedder_identity_hash');
  const currentHash = embedder.identityHash?.() ?? null;
  if (currentHash !== null && storedHash && storedHash !== currentHash) {
    reasons.push(
      `embedder identity hash changed for ${currentModel}: weights swapped under the same model id ` +
      `(probably an \`ollama pull\` updated the tag) — re-embedding to match the new weights`,
    );
    needsReindex = true;
    dropEmbeddingState(db);
    ensureVecTables(db, currentDim);
    setMetadata(db, 'embedder_identity_hash', currentHash);
  } else if (currentHash !== null && !storedHash) {
    // First-ever stamp. No reindex.
    setMetadata(db, 'embedder_identity_hash', currentHash);
  }

  // Ollama: refresh the metadata cache from live `/api/show` values on every
  // boot. Ollama is the only provider where `dim` and `max_tokens` are both
  // (a) authoritatively known by the runtime (the loaded weights), and
  // (b) cheap to fetch (a single local HTTP call done in `embedder.init()`).
  // Other providers either have no such API (transformers.js gets dim from
  // the loaded ONNX, max-tokens from tokenizer config) or are too expensive
  // to refetch every boot (HF live).
  //
  // Override semantics: every field the user has set via `models override`
  // wins over the live Ollama value. The override file (model-overrides.json)
  // is keyed by `embedder.modelIdentifier()` — for Ollama that's
  // `ollama:<model>`; for transformers.js it's the bare HF id. So a user
  // running `models override ollama:bge-m3 --max-tokens 1024` keeps 1024
  // even though Ollama reports 8192 for the same model. Live values are
  // truth-of-record only for fields the user hasn't explicitly opted out of.
  if (
    embedder.providerName() === 'ollama' &&
    typeof embedder.getContextLength === 'function'
  ) {
    const liveCtx = embedder.getContextLength();
    if (liveCtx !== null && liveCtx > 0) {
      const overrides = loadOverrides();
      const userOverride = overrides.get(currentModel) ?? null;
      const existing = loadCachedMetadata(db, currentModel);
      // For each field, prefer (user override) over (live Ollama) over
      // (existing cached) — never silently regress to a less-fresh value.
      const newMaxTokens = userOverride?.maxTokens ?? liveCtx;
      const newDim = currentDim;
      // Only write if anything would actually change — avoids per-boot
      // metadata churn when nothing's drifted.
      const dirty =
        existing === null ||
        existing.maxTokens !== newMaxTokens ||
        existing.dim !== newDim;
      if (dirty) {
        upsertCachedMetadata(db, {
          modelId: currentModel,
          dim: newDim,
          maxTokens: newMaxTokens,
          // Preserve the existing prefix fields — those flow through the
          // resolver chain (override → seed → HF Tier 3) on next read,
          // and writing them here would either duplicate that work or
          // regress to stale values. Same for the source-attribution
          // fields. We only refresh dim + max-tokens from Ollama.
          queryPrefix: existing?.queryPrefix ?? null,
          documentPrefix: existing?.documentPrefix ?? null,
          prefixSource: existing?.prefixSource ?? 'none',
          baseModel: existing?.baseModel ?? null,
          sizeBytes: existing?.sizeBytes ?? null,
          fetchedAt: Date.now(),
        });
        if (existing && (existing.maxTokens !== newMaxTokens || existing.dim !== newDim)) {
          reasons.push(
            `Ollama live values refreshed: dim=${newDim} max-tokens=${newMaxTokens} ` +
            `(prev cached: dim=${existing.dim} max-tokens=${existing.maxTokens})`,
          );
        }
      }
    }
  }

  // Schema upgrade: v1.3.1 stored nothing in chunks. If we have nodes but
  // zero chunks, trigger a reindex so chunks_vec gets populated.
  const hasNodes = allNodeIds(db).length > 0;
  if (hasNodes && countChunks(db) === 0) {
    reasons.push('chunk table is empty — rebuilding per-chunk embeddings (v1.4.0 upgrade)');
    needsReindex = true;
  }

  // Schema upgrade: FTS tokenizer change. Swap it in place (no reindex of
  // content needed — the markdown bodies didn't change, only how we
  // tokenise them).
  const ftsTok = currentFtsTokenize(db);
  if (hasNodes && ftsTok !== EXPECTED_FTS_TOKENIZE) {
    reasons.push(
      `FTS tokenizer changed: ${ftsTok ?? '(none)'} -> ${EXPECTED_FTS_TOKENIZE}; rebuilding nodes_fts`,
    );
    rebuildFullTextIndex(db);
  }

  // Schema migrations run as an explicit chain (classic umzug / rails shape).
  // Each entry is keyed by the version it upgrades TO and must be idempotent
  // (every helper is PRAGMA-guarded). We walk the chain in order, bumping
  // schema_version incrementally so a crash mid-chain is safe — the next boot
  // picks up from wherever we stopped.
  //
  // Data migrations (model/dim change, empty chunks, FTS tokenizer swap,
  // prefix-strategy change) are handled by the detection branches above /
  // below this block — they work by forcing a reindex, not by ALTERing the
  // table, so they don't belong in this chain.
  if (storedModel) {
    for (const m of SCHEMA_MIGRATIONS) {
      if (storedSchema < m.to) {
        m.apply(db);
        setMetadata(db, 'schema_version', String(m.to));
      }
    }
    if (storedSchema < SCHEMA_VERSION) {
      reasons.push(`schema version changed: ${storedSchema} → ${SCHEMA_VERSION}`);
      needsReindex = true;
    }
  }

  // Belt-and-braces: every migration helper is idempotent, so running the
  // whole chain unconditionally on every boot costs nothing and heals DBs
  // where the stored schema_version got ahead of the actual schema (pre-
  // v1.6.9 bug class — helper imported but never called).
  for (const m of SCHEMA_MIGRATIONS) {
    m.apply(db);
  }

  // Stratified prefix-strategy migration: only fires for transformers.js users
  // with asymmetric models (BGE, E5, Nomic, mxbai, Arctic Embed). MiniLM and
  // Ollama users are never reindexed via this path.
  //
  // Only compare against a previously-stored strategy — first boot (no
  // storedModel) just stamps the value with no reindex needed (DB is empty).
  const storedStrategy = getMetadata(db, 'embedder_prefix_strategy') ?? '';
  const currentStrategy = computePrefixStrategy(embedder);
  if (storedStrategy !== currentStrategy) {
    if (!storedModel) {
      // First boot: stamp and move on — nothing to reindex yet.
    } else if (currentStrategy === '' && storedStrategy !== '') {
      // Switched to a symmetric model — old vectors may have been built with
      // a query prefix baked in. Reindex to drop them.
      reasons.push(
        'switched to symmetric model — reindexing document chunks to drop stale query-prefix-assumed vectors',
      );
      needsReindex = true;
    } else if (currentStrategy !== '') {
      // Asymmetric model with a changed (or first-seen) prefix strategy.
      const model = embedder.modelIdentifier();
      reasons.push(
        `prefix strategy changed for ${model}${storedStrategy ? '' : ' (first v1.5.1 boot)'} — re-embedding document chunks with correct prefix`,
      );
      needsReindex = true;
    }
    // else: both empty (both symmetric) — no-op.
    setMetadata(db, 'embedder_prefix_strategy', currentStrategy);
  }

  return {
    needsReindex,
    reasons,
  };
}
