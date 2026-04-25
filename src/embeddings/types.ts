/**
 * Resolved model metadata as flowed in by the v1.7.5 metadata-resolver.
 * Re-declared here (rather than imported from `metadata-resolver.ts`) to keep
 * the `Embedder` interface free of cross-module dependencies — the resolver
 * imports `Embedder` from this file, and a circular import would prevent that.
 *
 * Shape mirrors `ResolvedMetadata` in `metadata-resolver.ts` exactly; if you
 * extend one, extend the other.
 */
export interface EmbedderMetadata {
  modelId: string;
  dim: number | null;
  maxTokens: number;
  queryPrefix: string;
  documentPrefix: string;
  prefixSource: 'override' | 'seed' | 'metadata' | 'metadata-base' | 'readme' | 'fallback' | 'none';
  baseModel: string | null;
  sizeBytes: number | null;
}

/**
 * Pluggable embedder contract.
 *
 * An Embedder turns text into a normalised Float32Array. The concrete
 * implementation (transformers.js, ONNX, a remote HTTP service, etc.) is
 * swappable behind this interface so callers never depend on a specific
 * model runtime.
 *
 * `taskType` is a hint for models that support asymmetric embedding
 * (e.g. bge-* exposes a different prefix for "document" vs "query").
 * Implementations that don't distinguish ignore the hint.
 */
export interface Embedder {
  /** Initialise backing model/runtime. Must be called before embed(). */
  init(): Promise<void>;

  /** Embed a single text. Must be called after init(). */
  embed(text: string, taskType?: 'document' | 'query'): Promise<Float32Array>;

  /** Output dimensionality — same for every vector this Embedder produces. */
  dimensions(): number;

  /**
   * Stable identifier of the underlying model (e.g. "Xenova/bge-small-en-v1.5").
   * Persisted in the index so we can auto-reindex on model change.
   */
  modelIdentifier(): string;

  /** Short human-readable backend name (e.g. "transformers.js"). */
  providerName(): string;

  /**
   * v1.7.5+: store resolved metadata so embed() can apply the correct
   * query/document prefix without consulting a hardcoded if/else table.
   * Optional — implementations that handle prefixes per-call (Ollama)
   * may treat this as a no-op storage, while transformers.js reads it
   * on every embed() call.
   */
  setMetadata?(meta: EmbedderMetadata): void;

  /** v1.7.5+: read back the metadata currently in effect, or null. */
  getMetadata?(): EmbedderMetadata | null;

  /**
   * Optional architectural context-window cap for the loaded model. Currently
   * exposed by `OllamaEmbedder` via `/api/show`'s
   * `model_info.<arch>.context_length` (verified live: nomic=2048,
   * mxbai-embed-large=512, all-minilm=512, bge-m3=8192). Bootstrap reads
   * this on every boot and refreshes the metadata cache with the
   * authoritative value, preserving any user override. Returns null when
   * the embedder doesn't expose live capacity (e.g. transformers.js,
   * which has it only via tokenizer config — already handled by
   * `getCapacity` separately).
   */
  getContextLength?(): number | null;

  /**
   * Optional content-addressable identity for the loaded weights. Provider-
   * specific. Used by `bootstrap.ts` as a SECOND change-detection signal
   * alongside `modelIdentifier()`/`dimensions()` — when the underlying
   * weights swap silently (e.g. `ollama pull bge-m3` replaces the local
   * weights with a newer build under the same tag), the model id string
   * doesn't change but `identityHash()` does, and bootstrap auto-reindexes.
   *
   * Implementations:
   *   - OllamaEmbedder: returns the model's manifest digest from `/api/tags`
   *     (sha256). Null when Ollama is unreachable at init time — bootstrap
   *     skips the check, no spurious reindex.
   *   - TransformersEmbedder: returns null. transformers.js loads via HF
   *     revision (cached locally), much rarer to silently change.
   *
   * Stored as `embedder_identity_hash` in the index_metadata table.
   * First-boot semantics: stored hash absent → just stamp, no reindex
   * (we don't know if the data was built under a different hash).
   */
  identityHash?(): string | null;

  /** Release any resources (GPU memory, worker threads, etc.). */
  dispose(): Promise<void>;
}
