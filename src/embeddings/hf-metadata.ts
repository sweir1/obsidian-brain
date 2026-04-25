/**
 * Layer 1 (v1.7.5): pure HuggingFace API client. No DB. No project deps.
 *
 * Resolves embedding-model metadata from HF's REST API by reading the model's
 * `config.json`, `tokenizer_config.json`, `sentence_bert_config.json`,
 * `config_sentence_transformers.json`, and `modules.json` in parallel.
 * Optionally cross-checks the upstream `base_model` for prompts when the
 * direct repo doesn't ship a `prompts` field.
 *
 * Used both at build time (`scripts/build-seed.mjs` to populate
 * `data/seed-models.json`) and at runtime when a BYOM model isn't in the
 * seed (Layer 3 calls this from `metadata-resolver.ts`).
 *
 * Tier 3 README fingerprinting is intentionally NOT included in v1.7.5 —
 * its false-positive risk on long-form READMEs is too high to ship without
 * an eval harness. Deferred to v1.7.6 or beyond.
 */

const HF_BASE = 'https://huggingface.co';
const HF_API = 'https://huggingface.co/api';

/** Sane upper bound when reading max-token-style config fields. Some models
 *  set these to INT32_MAX as a sentinel; we treat anything above this as
 *  "no useful limit declared" and fall through to the next layer. */
const SANE_MAX_TOKENS = 1_000_000;

/** Default per-request timeout. HF API is normally <100ms; 5s is generous. */
export const DEFAULT_HF_TIMEOUT_MS = 5_000;

/** Default retry count for transient (5xx / network) failures. */
export const DEFAULT_HF_RETRIES = 2;

export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' | 'int8' | 'uint8' | 'bnb4';

export type PrefixSource = 'metadata' | 'metadata-base' | 'none';

export interface HfMetadata {
  /** Canonical HF model id (org/name). */
  modelId: string;
  /** transformers `model_type` (e.g. 'bert', 'xlm-roberta', 't5'). */
  modelType: string;
  /** Hidden size from config.json — pre-Dense-projection. */
  hiddenSize: number;
  /** Number of transformer layers. */
  numLayers: number;
  /** Output embedding dim — overridden by Dense layer's `out_features` when present. */
  dim: number;
  /** True if `modules.json` declares a Dense layer (post-pooling projection). */
  hasDenseLayer: boolean;
  /** True if `modules.json` declares a Normalize layer (cosine-similarity-friendly). */
  hasNormalize: boolean;
  /** Effective max input tokens. Resolved with the priority: sentence_bert_config.max_seq_length →
   *  tokenizer_config.model_max_length → config.max_position_embeddings (xlm-roberta -2 offset). */
  maxTokens: number;
  /** From `config_sentence_transformers.json prompts.query`, or upstream `base_model`'s same JSON. */
  queryPrefix: string | null;
  /** From `config_sentence_transformers.json prompts.document` (or `passage`). */
  documentPrefix: string | null;
  /** Where the prefixes came from. 'none' → no prompts field anywhere. */
  prefixSource: PrefixSource;
  /** Upstream model id from README YAML frontmatter `base_model:`, or null. */
  baseModel: string | null;
  /** Total bytes of the requested ONNX dtype variant (q8 by default), or null. */
  sizeBytes: number | null;
  /** Diagnostic: which sources contributed to this metadata. */
  sources: {
    hadModulesJson: boolean;
    hadSentenceBertConfig: boolean;
    hadSentenceTransformersConfig: boolean;
    hadOnnxDir: boolean;
    maxTokensFrom: 'sentence_bert_config' | 'tokenizer_config' | 'config' | 'default';
  };
}

export interface HfMetadataOptions {
  /** Quantization variant whose ONNX file size we want to report. Default 'q8'. */
  dtype?: Dtype;
  /** Git revision (branch / commit / tag) to resolve files against. Default 'main'. */
  revision?: string;
  /** Per-request timeout in ms. Default DEFAULT_HF_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max retries for 5xx / network failures (4xx is permanent, no retry). Default DEFAULT_HF_RETRIES. */
  retries?: number;
  /** Injected fetch — defaults to globalThis.fetch. Lets tests substitute. */
  fetcher?: typeof fetch;
}

const ONNX_FILE_BY_DTYPE: Record<Dtype, string> = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8: 'model_quantized.onnx',
  q4: 'model_q4.onnx',
  q4f16: 'model_q4f16.onnx',
  int8: 'model_int8.onnx',
  uint8: 'model_uint8.onnx',
  bnb4: 'model_bnb4.onnx',
};

interface SentenceTransformersModule {
  idx: number;
  name: string;
  path: string;
  type: string;
}

interface HfTreeFile {
  type: string;
  path: string;
  size: number;
}

interface ConfigJson {
  hidden_size?: number;
  d_model?: number;
  n_embd?: number;
  n_embed?: number;
  max_position_embeddings?: number;
  n_positions?: number;
  max_trained_positions?: number;
  model_type?: string;
  num_hidden_layers?: number;
  num_layers?: number;
  n_layer?: number;
}

interface PromptsBlock {
  prompts?: { query?: string; document?: string; passage?: string };
}

interface DenseConfig {
  in_features?: number;
  out_features?: number;
}

/**
 * Fetch raw text or JSON from HF with retry+backoff on 5xx, no-retry on 4xx,
 * AbortController-based timeout. Returns null on permanent (404) or
 * exhausted-retry failures so callers can decide their fallback per-file.
 */
async function fetchWithRetry(
  url: string,
  opts: { timeoutMs: number; retries: number; fetcher: typeof fetch },
): Promise<Response | null> {
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await opts.fetcher(url, { signal: ctrl.signal });
      clearTimeout(timer);
      // 5xx → retry. 4xx → permanent, return null. 2xx/3xx → return.
      if (res.status >= 500 && attempt < opts.retries) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return res;
    } catch (err) {
      clearTimeout(timer);
      // AbortError or network error: retry if budget remains.
      if (attempt < opts.retries) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchJson<T>(url: string, opts: { timeoutMs: number; retries: number; fetcher: typeof fetch }): Promise<T | null> {
  const res = await fetchWithRetry(url, opts);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string, opts: { timeoutMs: number; retries: number; fetcher: typeof fetch }): Promise<string | null> {
  const res = await fetchWithRetry(url, opts);
  if (!res) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract a `base_model:` value from a README's YAML frontmatter, or null.
 * Handles a single-string value or an array (returns the first entry).
 */
export function extractBaseModel(readme: string): string | null {
  const fm = readme.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  // Single-string form: `base_model: org/name`. Use `[ \t]*` (NOT `\s*`)
  // because `\s` matches `\n` and would silently swallow the line break,
  // making this regex incorrectly fire on the list form.
  const single = fm[1].match(/^base_model:[ \t]*(.+)$/m);
  if (single) {
    return single[1].trim().replace(/^["']|["']$/g, '');
  }
  // List form: `base_model:\n  - org/name`.
  const list = fm[1].match(/^base_model:[ \t]*\n[ \t]*-[ \t]*(.+)$/m);
  if (list) {
    return list[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

interface ResolvedPrompts {
  query: string | null;
  document: string | null;
  source: PrefixSource;
  baseModel: string | null;
}

/**
 * Two-tier prompt resolution: canonical JSON on this repo, then upstream
 * `base_model`'s same JSON when the direct repo has no `prompts` field.
 *
 * Tier 3 README fingerprinting is deferred to v1.7.6.
 */
async function resolvePrompts(
  modelId: string,
  revision: string,
  opts: { timeoutMs: number; retries: number; fetcher: typeof fetch },
): Promise<ResolvedPrompts> {
  // Tier 1: canonical JSON on the model's own repo.
  const direct = await fetchJson<PromptsBlock>(
    `${HF_BASE}/${modelId}/resolve/${revision}/config_sentence_transformers.json`,
    opts,
  );
  if (direct?.prompts && (direct.prompts.query || direct.prompts.document || direct.prompts.passage)) {
    return {
      query: direct.prompts.query ?? null,
      document: direct.prompts.document ?? direct.prompts.passage ?? null,
      source: 'metadata',
      baseModel: null,
    };
  }

  // Tier 2: read README, extract base_model, re-fetch.
  const readme = await fetchText(`${HF_BASE}/${modelId}/resolve/${revision}/README.md`, opts);
  const baseModel = readme ? extractBaseModel(readme) : null;
  if (baseModel && baseModel !== modelId) {
    const upstream = await fetchJson<PromptsBlock>(
      `${HF_BASE}/${baseModel}/resolve/main/config_sentence_transformers.json`,
      opts,
    );
    if (upstream?.prompts && (upstream.prompts.query || upstream.prompts.document || upstream.prompts.passage)) {
      return {
        query: upstream.prompts.query ?? null,
        document: upstream.prompts.document ?? upstream.prompts.passage ?? null,
        source: 'metadata-base',
        baseModel,
      };
    }
  }

  return { query: null, document: null, source: 'none', baseModel };
}

/**
 * Fetch metadata for a HuggingFace embedding model.
 *
 * Throws (only) when:
 *   - `config.json` is unreachable / 404 (model doesn't exist).
 *   - `config.json` has no scalar embedding dim (multimodal / vision /
 *     audio model with nested configs — Layer 1 cannot represent these).
 *
 * All other config files are best-effort — missing files fall through to
 * fallback values, never throw.
 */
export async function getEmbeddingMetadata(
  modelId: string,
  options: HfMetadataOptions = {},
): Promise<HfMetadata> {
  const dtype = options.dtype ?? 'q8';
  const revision = options.revision ?? 'main';
  const timeoutMs = options.timeoutMs ?? DEFAULT_HF_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_HF_RETRIES;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const opts = { timeoutMs, retries, fetcher };
  const resolveBase = `${HF_BASE}/${modelId}/resolve/${revision}`;

  // Fan out the five config fetches in parallel. config.json is required;
  // the rest are best-effort.
  const [config, tokenizerConfig, sbertConfig, stConfig, modules] = await Promise.all([
    fetchJson<ConfigJson>(`${resolveBase}/config.json`, opts),
    fetchJson<{ model_max_length?: number }>(`${resolveBase}/tokenizer_config.json`, opts),
    fetchJson<{ max_seq_length?: number }>(`${resolveBase}/sentence_bert_config.json`, opts),
    fetchJson<unknown>(`${resolveBase}/config_sentence_transformers.json`, opts),
    fetchJson<SentenceTransformersModule[]>(`${resolveBase}/modules.json`, opts),
  ]);

  if (!config) {
    throw new Error(
      `obsidian-brain: HF metadata: config.json not reachable for ${modelId} ` +
      `(model may not exist, be private, or HF is unreachable)`,
    );
  }

  // Different families use different field names for the embedding dim.
  // BERT/RoBERTa: hidden_size. T5: d_model. GPT-2/nomic_bert: n_embd. Bloom: n_embed.
  const hiddenSize = config.hidden_size ?? config.d_model ?? config.n_embd ?? config.n_embed;
  const numLayers = config.num_hidden_layers ?? config.num_layers ?? config.n_layer ?? 0;
  const maxPositionEmbeddings =
    config.max_position_embeddings ?? config.n_positions ?? config.max_trained_positions;

  if (typeof hiddenSize !== 'number') {
    throw new Error(
      `obsidian-brain: HF metadata: ${modelId} has no scalar embedding dim in config.json ` +
      `(model_type=${config.model_type ?? '?'}). Likely a multimodal/audio/vision model with ` +
      `nested configs — not a single-tower text embedding model.`,
    );
  }

  // Walk modules.json for Dense + Normalize layers. If a Dense layer exists,
  // the output dim is its `out_features`, not `hidden_size`.
  let hasDenseLayer = false;
  let hasNormalize = false;
  let dim = hiddenSize;
  if (Array.isArray(modules)) {
    for (const mod of modules) {
      if (mod.type.endsWith('.Normalize')) hasNormalize = true;
      if (mod.type.endsWith('.Dense')) {
        hasDenseLayer = true;
        const denseConfig = await fetchJson<DenseConfig>(`${resolveBase}/${mod.path}/config.json`, opts);
        if (denseConfig?.out_features) dim = denseConfig.out_features;
      }
    }
  }

  // Resolve max tokens with documented priority. Each source can be 0/null/
  // sentinel-large; defend against all of them.
  let maxTokens: number;
  let maxTokensFrom: HfMetadata['sources']['maxTokensFrom'];
  if (sbertConfig?.max_seq_length && sbertConfig.max_seq_length < SANE_MAX_TOKENS && sbertConfig.max_seq_length > 0) {
    maxTokens = sbertConfig.max_seq_length;
    maxTokensFrom = 'sentence_bert_config';
  } else if (
    tokenizerConfig?.model_max_length &&
    tokenizerConfig.model_max_length < SANE_MAX_TOKENS &&
    tokenizerConfig.model_max_length > 0
  ) {
    maxTokens = tokenizerConfig.model_max_length;
    maxTokensFrom = 'tokenizer_config';
  } else if (maxPositionEmbeddings && maxPositionEmbeddings < SANE_MAX_TOKENS) {
    // xlm-roberta reserves two positions for special tokens; the effective
    // input length is max_position_embeddings - 2.
    maxTokens = config.model_type === 'xlm-roberta' ? maxPositionEmbeddings - 2 : maxPositionEmbeddings;
    maxTokensFrom = 'config';
  } else {
    maxTokens = 512;
    maxTokensFrom = 'default';
  }

  const prompts = await resolvePrompts(modelId, revision, opts);

  // ONNX file size — best effort. The HF tree API returns directory listing
  // with file sizes; we read the requested dtype's file plus its `.onnx_data`
  // sidecar (used by onnx-community for >2GB external-data weights).
  let sizeBytes: number | null = null;
  let hadOnnxDir = false;
  const onnxFile = ONNX_FILE_BY_DTYPE[dtype];
  if (onnxFile) {
    const tree = await fetchJson<HfTreeFile[]>(`${HF_API}/models/${modelId}/tree/${revision}/onnx`, opts);
    if (Array.isArray(tree)) {
      hadOnnxDir = true;
      const main = tree.find((f) => f.path === `onnx/${onnxFile}`);
      const sidecar = tree.find((f) => f.path === `onnx/${onnxFile}_data`);
      if (main) sizeBytes = main.size + (sidecar?.size ?? 0);
    }
  }

  return {
    modelId,
    modelType: config.model_type ?? 'unknown',
    hiddenSize,
    numLayers,
    dim,
    hasDenseLayer,
    hasNormalize,
    maxTokens,
    queryPrefix: prompts.query,
    documentPrefix: prompts.document,
    prefixSource: prompts.source,
    baseModel: prompts.baseModel,
    sizeBytes,
    sources: {
      hadModulesJson: Array.isArray(modules),
      hadSentenceBertConfig: sbertConfig !== null,
      hadSentenceTransformersConfig: stConfig !== null,
      hadOnnxDir,
      maxTokensFrom,
    },
  };
}
