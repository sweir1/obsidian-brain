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

  /** Release any resources (GPU memory, worker threads, etc.). */
  dispose(): Promise<void>;
}
