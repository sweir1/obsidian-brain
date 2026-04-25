import { pipeline, env as hfEnv } from '@huggingface/transformers';
import type { Embedder as EmbedderInterface, EmbedderMetadata } from './types.js';
import { EmbedderLoadError, classifyLoadError } from './errors.js';

// Honour TRANSFORMERS_CACHE (and HF_HOME, the HF Python convention) if set,
// overriding transformers.js's default of `./.cache`. Lets CI pin the cache
// to a known path (see .github/workflows/release.yml) for `actions/cache`.
const cacheOverride = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
if (cacheOverride) {
  hfEnv.cacheDir = cacheOverride;
}

/**
 * v1.7.5: the family-pattern `getTransformersPrefix` if/else chain has been
 * deleted. Prefixes are now resolved by the metadata-cache + seed + HF
 * fallback chain in `metadata-resolver.ts` and pushed into the embedder
 * instance via `setMetadata()`. embed() reads them off `this._metadata`.
 *
 * Tests that previously called `getTransformersPrefix(modelId, taskType)`
 * directly should construct a `ResolvedMetadata` and call `setMetadata()`,
 * or call `metadataResolver.resolveModelMetadata(modelId, ...)`.
 */

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

// The `pipeline()` generic return type from @huggingface/transformers is a
// tagged union over every supported task, which hits TS2590 ("union type too
// complex") under strict mode. We cast through `unknown` to a minimal shape.
interface Extractor {
  (text: string, options: { pooling: 'mean'; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
  dispose(): Promise<void>;
}

/**
 * transformers.js-backed Embedder. Loads a sentence-embedding model from
 * Hugging Face (via EMBEDDING_MODEL or the constructor argument), probes its
 * output dim on init, and serialises embed() calls to work around the
 * single-threaded runtime.
 */
export class TransformersEmbedder implements EmbedderInterface {
  private extractor: Extractor | null = null;
  private _dim: number | null = null;
  private readonly _model: string;
  private lastRun: Promise<void> = Promise.resolve();
  private _metadata: EmbedderMetadata | null = null;

  constructor(model?: string) {
    this._model = model ?? process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
  }

  /**
   * v1.7.5+: receive resolved metadata from the metadata-resolver chain.
   * Callers must invoke this AFTER init() but BEFORE the first embed() call
   * for the prefix to be applied. If not called, embed() falls back to
   * empty prefixes (treats as symmetric — degraded but doesn't crash).
   */
  setMetadata(meta: EmbedderMetadata): void {
    if (meta.modelId !== this._model) {
      throw new Error(
        `obsidian-brain: TransformersEmbedder.setMetadata: model mismatch — ` +
        `metadata is for ${meta.modelId}, embedder is for ${this._model}`,
      );
    }
    this._metadata = meta;
  }

  /** Read back the metadata last set, or null. */
  getMetadata(): EmbedderMetadata | null {
    return this._metadata;
  }

  async init(): Promise<void> {
    try {
      this.extractor = await this.loadPipelineWithCorruptCacheRecovery();
      // Probe output length so callers can validate the DB's vec0 dim before
      // any embeds are written. Space is a cheap input.
      const probe = await this.extractor(' ', { pooling: 'mean', normalize: true });
      const vec = probe.tolist()[0];
      if (!vec || vec.length === 0) {
        throw new Error(
          `Embedder produced empty vector for model "${this._model}". ` +
            `Check the model exists on Hugging Face and outputs sentence embeddings.`,
        );
      }
      this._dim = vec.length;
    } catch (err) {
      // If it's already our error type (or a specific known internal error), rethrow as-is
      if (err instanceof EmbedderLoadError) throw err;
      throw classifyLoadError(this._model, err);
    }
  }

  /**
   * Load the transformers.js pipeline, with a one-shot retry if the cached
   * ONNX file looks corrupt. A truncated download from a killed prior run
   * leaves a file that fails `Protobuf parsing` / `Load model … failed` when
   * onnxruntime tries to parse it. Nuking the model's cache subdirectory
   * and letting transformers.js re-download is the safe recovery — the
   * cache is content-addressed under the model id, so we only delete our
   * own model's subtree, not other users' models.
   */
  private async loadPipelineWithCorruptCacheRecovery(): Promise<Extractor> {
    try {
      return (await pipeline('feature-extraction', this._model, {
        dtype: 'q8',
      })) as unknown as Extractor;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const corrupt =
        /Protobuf parsing failed/i.test(msg) ||
        /Load model .* failed/i.test(msg) ||
        /Invalid model file/i.test(msg);
      if (!corrupt) throw err;

      process.stderr.write(
        `obsidian-brain: embedder load failed with "${msg.slice(0, 120)}..."; ` +
          `this is usually a corrupt HF cache from a killed prior download. ` +
          `Clearing the cache for "${this._model}" and retrying once.\n`,
      );
      await this.clearModelCache();
      // One retry — if it fails again, throw the fresh error.
      return (await pipeline('feature-extraction', this._model, {
        dtype: 'q8',
      })) as unknown as Extractor;
    }
  }

  private async clearModelCache(): Promise<void> {
    try {
      // The transformers.js cache layout is:
      //   <TRANSFORMERS_CACHE or node_modules/@huggingface/transformers/.cache>/<ModelNamespace>/<ModelName>/
      // Resolve the cache root the same way the library does (env var > hfEnv default).
      const { env: hfEnv } = await import('@huggingface/transformers');
      const cacheRoot =
        process.env.TRANSFORMERS_CACHE ??
        process.env.HF_HOME ??
        (hfEnv as unknown as { cacheDir?: string })?.cacheDir ??
        '';
      if (!cacheRoot) return;
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const modelDir = path.join(cacheRoot, this._model);
      await fs.rm(modelDir, { recursive: true, force: true });
    } catch (clearErr) {
      process.stderr.write(
        `obsidian-brain: could not clear HF cache directory: ${String((clearErr as Error)?.message ?? clearErr)}\n`,
      );
      // Swallow — if we can't clear it, the retry will likely fail the same way
      // and the original error will propagate, which is correct behaviour.
    }
  }

  /** Legacy numeric alias — new code should call dimensions(). */
  get dim(): number {
    if (this._dim === null) {
      throw new Error('Embedder not initialized. Call init() first.');
    }
    return this._dim;
  }

  /** Legacy string alias — new code should call modelIdentifier(). */
  get model(): string {
    return this._model;
  }

  dimensions(): number {
    return this.dim;
  }

  modelIdentifier(): string {
    return this._model;
  }

  providerName(): string {
    return 'transformers.js';
  }

  async embed(text: string, taskType: 'document' | 'query' = 'document'): Promise<Float32Array> {
    if (!this.extractor) throw new Error('Embedder not initialized. Call init() first.');
    const extractor = this.extractor;
    // v1.7.5: prefix comes from resolved metadata (cache → seed → HF), not
    // a hardcoded family-pattern table. If setMetadata() wasn't called we
    // fall through to '' (treat as symmetric — degraded but doesn't crash).
    const prefix = this._metadata
      ? (taskType === 'query' ? this._metadata.queryPrefix : this._metadata.documentPrefix)
      : '';
    // Runtime substitution for `{text}` placeholders. Build-seed
    // (`scripts/build-seed.py:_normalize_prompt_template`) only ships
    // templates whose placeholders are all `{text}` (single or multiple,
    // e.g. "Task: {text}\nQuery: {text}"); anything else is dropped.
    // `replaceAll` is required for multi-`{text}` templates.
    const prefixedText = prefix.includes('{text}') ? prefix.replaceAll('{text}', text) : prefix + text;
    const run = this.lastRun.then(async () =>
      extractor(prefixedText, {
        pooling: 'mean',
        normalize: true,
      }),
    );
    // Chain regardless of previous failure so one throw doesn't permanently wedge the queue.
    this.lastRun = run.then(
      () => undefined,
      () => undefined,
    );
    const output = await run;
    return new Float32Array(output.tolist()[0] ?? []);
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }

  /**
   * Build a concatenated string from title + tags + first paragraph for the
   * note-level (coarse) embedding. Retained for the whole-note fallback; the
   * chunker produces its own per-chunk strings.
   *
   * @deprecated As of v1.4.0 the chunker emits per-chunk text directly. This
   * helper is only used for the note-level mean-pooled fallback vector.
   */
  static buildEmbeddingText(
    title: string,
    tags: string[],
    content: string,
  ): string {
    const firstParagraph = content.split(/\n\n+/)[0] ?? '';
    const parts = [title];
    if (tags.length > 0) {
      parts.push(tags.join(', '));
    }
    if (firstParagraph) {
      parts.push(firstParagraph);
    }
    return parts.join('\n');
  }
}

/**
 * Back-compat alias — existing call sites import `Embedder` from this module.
 * New code should import `TransformersEmbedder` explicitly, or the
 * `Embedder` interface from `./types.js` for typing only.
 */
export { TransformersEmbedder as Embedder };
