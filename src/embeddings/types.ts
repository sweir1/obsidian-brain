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

  /** Release any resources (GPU memory, worker threads, etc.). */
  dispose(): Promise<void>;
}
