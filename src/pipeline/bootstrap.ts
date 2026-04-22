import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '../store/db.js';
import {
  dropEmbeddingState,
  ensureVecTables,
  rebuildFullTextIndex,
  currentFtsTokenize,
  SCHEMA_VERSION,
} from '../store/db.js';
import { getMetadata, setMetadata } from '../store/metadata.js';
import { countChunks } from '../store/chunks.js';
import { allNodeIds } from '../store/nodes.js';
import type { Embedder } from './../embeddings/types.js';
import { getTransformersPrefix } from '../embeddings/embedder.js';

const EXPECTED_FTS_TOKENIZE = 'porter unicode61';

/**
 * Version that increments whenever the prefix table in getTransformersPrefix
 * changes. Folded into the hash so a prefix-table update forces a reindex
 * even if the prefix strings themselves are identical.
 */
const PREFIX_STRATEGY_VERSION = 1;

/**
 * Compute a stable hash of the prefix strategy for the given model+provider.
 * Returns '' for symmetric models or non-transformers providers (Ollama
 * handles prefix application per-call; we never need to reindex on its behalf).
 */
function computePrefixStrategy(model: string, provider: string): string {
  // Ollama handles prefixes per-call inside OllamaEmbedder; we never need
  // to reindex on provider-side prefix changes.
  if (provider !== 'transformers.js') return '';
  const q = getTransformersPrefix(model, 'query');
  const d = getTransformersPrefix(model, 'document');
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

  // Only fire the schema-version migration when upgrading an existing DB
  // (i.e., storedModel was set — first boot already wrote the correct version
  // in the branch above).
  if (storedModel && storedSchema !== SCHEMA_VERSION) {
    reasons.push(`schema version changed: ${storedSchema} → ${SCHEMA_VERSION}`);
    needsReindex = true;
    setMetadata(db, 'schema_version', String(SCHEMA_VERSION));
  }

  // Stratified prefix-strategy migration: only fires for transformers.js users
  // with asymmetric models (BGE, E5, Nomic, mxbai, Arctic Embed). MiniLM and
  // Ollama users are never reindexed via this path.
  //
  // Only compare against a previously-stored strategy — first boot (no
  // storedModel) just stamps the value with no reindex needed (DB is empty).
  const storedStrategy = getMetadata(db, 'embedder_prefix_strategy') ?? '';
  const currentStrategy = computePrefixStrategy(
    embedder.modelIdentifier(),
    embedder.providerName(),
  );
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
