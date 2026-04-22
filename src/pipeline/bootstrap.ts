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

const EXPECTED_FTS_TOKENIZE = 'porter unicode61';

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

  if (storedSchema !== SCHEMA_VERSION) {
    setMetadata(db, 'schema_version', String(SCHEMA_VERSION));
  }

  return {
    needsReindex: reasons.some(
      (r) => r.includes('embedder changed') || r.includes('chunk table is empty'),
    ),
    reasons,
  };
}
