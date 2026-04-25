/**
 * Layer 1 (v1.7.5): pure HuggingFace API client. No DB. No project deps.
 *
 * Resolves embedding-model metadata from HF's REST API by reading the model's
 * `config.json`, `tokenizer_config.json`, `sentence_bert_config.json`,
 * `config_sentence_transformers.json`, and `modules.json` in parallel.
 * Optionally cross-checks the upstream `base_model` for prompts when the
 * direct repo doesn't ship a `prompts` field.
 *
 * Used at runtime when a BYOM model isn't in the bundled seed (Layer 3
 * calls this from `metadata-resolver.ts`). The release-time seed regen
 * (`scripts/build-seed.py`) reads MTEB's Python registry directly and
 * does not call this fetcher; the fetcher is BYOM-fallback-only now.
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

export type PrefixSource = 'metadata' | 'metadata-base' | 'readme' | 'none';

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

/**
 * Detect the model's primary language from YAML frontmatter `language:` or
 * (failing that) the model id's `-en-` / `-zh-` / `_ja` style suffix.
 * Returns ISO 639-1 code ('en', 'zh', 'ja', 'fa', 'ru', etc.) or null when
 * the model is multilingual or the language is undeclared.
 */
export function detectModelLanguage(readme: string | null, modelId: string): string | null {
  if (readme) {
    const fm = readme.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      // Append `\n` so list-form's per-entry `\n` requirement still matches
      // the LAST entry (the captured frontmatter ends right before `---`,
      // not after a newline).
      const yaml = fm[1] + '\n';
      // Single-line: `language: en`
      const single = yaml.match(/^language:[ \t]*([a-z]{2,3})[ \t]*$/m);
      if (single) return single[1].toLowerCase();
      // List form: `language:\n  - en\n`
      const listMatch = yaml.match(/^language:[ \t]*\n((?:[ \t]*-[ \t]*[a-z]{2,3}[ \t]*\n)+)/m);
      if (listMatch) {
        const langs = [...listMatch[1].matchAll(/-[ \t]*([a-z]{2,3})/g)].map((m) => m[1]);
        if (langs.length === 1) return langs[0].toLowerCase();
        return null; // multilingual list — don't claim a single language
      }
    }
  }
  // Fall back to model-id suffix conventions.
  const idMatch = modelId.match(/[-_/]([a-z]{2})(?:[-_.]|$)/i);
  if (idMatch) {
    const code = idMatch[1].toLowerCase();
    if (
      ['en', 'zh', 'ja', 'ko', 'ar', 'fa', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'vi', 'tr', 'pl', 'hi'].includes(code)
    ) {
      return code;
    }
  }
  return null;
}

/**
 * Map an ISO 639 language code to its dominant script class. Multi-script
 * languages (Japanese mixes kana + kanji — both treated as 'cjk' here)
 * collapse to the broadest family. Returns null for languages we don't
 * have a mapping for (the language filter then no-ops).
 */
export function languageToScript(lang: string): string | null {
  const map: Record<string, string> = {
    en: 'latin', de: 'latin', fr: 'latin', es: 'latin', pt: 'latin',
    it: 'latin', nl: 'latin', vi: 'latin', tr: 'latin', pl: 'latin', id: 'latin',
    zh: 'cjk',   ja: 'cjk',   ko: 'cjk',
    ar: 'arabic', fa: 'arabic', ur: 'arabic',
    ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic',
    hi: 'devanagari',
  };
  return map[lang] ?? null;
}

/**
 * Classify a candidate prefix string by dominant script. Used to filter
 * README-fingerprinted prefixes against the model's declared language —
 * fixes BGE-en picking the Chinese prefix because the EN+ZH README
 * documents both side-by-side and ZH appears more often.
 */
export function detectPrefixScript(prefix: string): string {
  // Strip punctuation/digits/whitespace before counting; pure-punctuation
  // strings shouldn't be reachable here (isPlausiblePrefix filters them
  // earlier) but defaulting to 'latin' is the safe choice.
  const text = prefix.replace(/[\s\d:：_/.\-,'"!?]/g, '');
  if (!text) return 'latin';
  let cjk = 0, arabic = 0, cyrillic = 0, latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
    else if (cp >= 0x41 && cp <= 0x7a) latin++;
  }
  const max = Math.max(cjk, arabic, cyrillic, latin);
  if (max === 0) return 'latin';
  if (cjk === max) return 'cjk';
  if (arabic === max) return 'arabic';
  if (cyrillic === max) return 'cyrillic';
  return 'latin';
}

// ---------------------------------------------------------------------------
// Tier 3: README fingerprinting
//
// Catches older models whose query/document prefix is documented in README
// prose only — BGE family, vanilla Nomic, etc. Generic pattern-matching, no
// per-model branches. Two real bugs caught + fixed during smoke-testing
// against ~300 random HF models:
//
//   (1) `BAAI/bge-small-en-v1.5` resolved to the Chinese prefix because the
//       README documents EN + ZH side-by-side and ZH appears 10× vs EN 6×.
//       Fix: language-aware script filter — when the model declares a single
//       language, drop candidates whose script doesn't match.
//
//   (2) `sentence-transformers/all-MiniLM-L6-v2` resolved
//       `"Sentence embeddings:"` as a query prefix — that's a Python
//       `print()` label, not a model prefix. Fix: real prefixes always end
//       in `": "` (Latin colon + space) or `"："` (full-width CJK colon)
//       because they prepend to text. Bare `":"` is rejected.
// ---------------------------------------------------------------------------

/**
 * Fingerprint a README for query/document prefixes. Generic — counts quoted
 * candidate strings and ranks by frequency + presence of query/instruction
 * keywords. When `expectedScript` is set (i.e. the model declares a single
 * language), candidates with a non-matching script are dropped first.
 */
export function resolvePromptsFromReadme(
  readme: string,
  expectedScript: string | null = null,
): { query: string | null; document: string | null } {
  // Strip the YAML frontmatter so we don't pick prefix-shaped values like
  // `description: "query: ..."` from the metadata block.
  const body = readme.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // Pull every quoted/backticked sub-200-char string. We over-collect on
  // purpose; isPlausiblePrefix below filters down to actual prefix shapes.
  const strings: string[] = [];
  for (const re of [/"([^"\n]{1,200})"/g, /'([^'\n]{1,200})'/g, /`([^`\n]{1,200})`/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) strings.push(m[1]);
  }

  const counts = new Map<string, number>();
  const bump = (s: string) => counts.set(s, (counts.get(s) ?? 0) + 1);

  for (const s of strings) {
    // Pattern A — the whole string IS a prefix. Must end in `": "` (Latin)
    // or `"："` (CJK fullwidth) so we don't fire on Python print labels.
    if (/(: |：)$/.test(s) && isPlausiblePrefix(s)) bump(s);
    // Pattern B — string starts with a `prefix: <body>` shape, e.g.
    // `"search_query: <text>"`. Capture just the prefix.
    const m = s.match(/^([A-Za-z][A-Za-z0-9 _]{2,40}: )/);
    if (m && isPlausiblePrefix(m[1])) bump(m[1]);
  }

  if (counts.size === 0) return { query: null, document: null };

  let ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Language-aware filter: when the model is single-language, drop candidates
  // from other scripts. Only applies when at least one candidate matches the
  // expected script (otherwise we'd return nothing for valid LLM-instruct
  // prompts that happen to be in another script for some reason).
  if (expectedScript) {
    const matchingScript = ranked.filter(([p]) => detectPrefixScript(p) === expectedScript);
    if (matchingScript.length > 0) ranked = matchingScript;
  }

  // A doc prefix is a *label-style* identifier that names the text as a
  // passage/document — `passage: `, `document: `, `search_document: `, etc.
  // The structural rule: single token, no spaces, of the form
  // `[<word>_]passage(s)/document(s)<colon><space>`. NOT instruction-prose
  // that happens to contain "passage" mid-text (e.g. BGE's `Represent this
  // sentence for searching relevant passages: ` is a QUERY prefix).
  const isDocPrefix = (p: string) => /^([a-z_]+_)?(passage|document)s?\s*[:：]\s*$/i.test(p);
  // Multilingual query/instruction keywords — a candidate that hits any of
  // these is treated as credible even if it appears only once in the README.
  const queryWords = /(query|search|represent|instruction|为这个句子|سوال|质问)/i;

  const credible = ranked.filter(([p, c]) => c >= 2 || queryWords.test(p));
  if (credible.length === 0) return { query: null, document: null };

  let docPrefix: string | null = null;
  let queryPrefix: string | null = null;
  for (const [p] of credible) {
    if (!docPrefix && isDocPrefix(p)) docPrefix = p;
    else if (!queryPrefix && !isDocPrefix(p)) queryPrefix = p;
    if (queryPrefix && docPrefix) break;
  }

  return { query: queryPrefix, document: docPrefix };
}

/**
 * Is `s` a plausibly-formed model prefix? Real prefixes always end in
 * `": "` (Latin colon-space, because they prepend to text) or `"："`
 * (full-width CJK colon, which already includes spacing visually).
 * Bare `":"` is rejected — that filters out Python print labels like
 * `"Sentence embeddings:"` which the all-MiniLM README contains.
 */
function isPlausiblePrefix(s: string): boolean {
  if (s.length < 5 || s.length > 80) return false;
  // No newlines / structural punctuation — would mean we caught a code line.
  if (/[\n\r{}\[\]()=<>|;]/.test(s)) return false;
  // Trailing-shape requirement (the load-bearing fix).
  if (!/(: |：)$/.test(s)) return false;
  // Reject obvious code/output noise.
  const trimmed = s.replace(/\s+$/, '');
  if (/^[#/]/.test(trimmed)) return false;
  if (/Score\s*:|Options\s*:/i.test(trimmed)) return false;
  return true;
}

interface ResolvedPrompts {
  query: string | null;
  document: string | null;
  source: PrefixSource;
  baseModel: string | null;
}

/**
 * Three-tier prompt resolution:
 *   1. canonical `config_sentence_transformers.json prompts` on this repo
 *   2. same JSON on the upstream `base_model` from README YAML frontmatter
 *   3. fingerprint the README itself (this repo, then the base_model's),
 *      with language-aware script filtering to keep BGE-en from picking
 *      the Chinese prefix when the EN+ZH README documents both
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

  // Tier 2: read README, extract base_model, re-fetch its config.
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

  // Tier 3: README fingerprinting — first this repo's README (if we have it),
  // then the upstream's. Language-aware script filter prevents BGE-en from
  // picking the Chinese prefix that appears more frequently in the
  // side-by-side EN+ZH README.
  const readmesToTry: Array<{ id: string; text: string }> = [];
  if (readme) readmesToTry.push({ id: modelId, text: readme });
  if (baseModel && baseModel !== modelId) {
    const upstreamReadme = await fetchText(
      `${HF_BASE}/${baseModel}/resolve/main/README.md`,
      opts,
    );
    if (upstreamReadme) readmesToTry.push({ id: baseModel, text: upstreamReadme });
  }
  for (const r of readmesToTry) {
    const lang = detectModelLanguage(r.text, r.id);
    const expectedScript = lang ? languageToScript(lang) : null;
    const fp = resolvePromptsFromReadme(r.text, expectedScript);
    if (fp.query || fp.document) {
      return {
        query: fp.query,
        document: fp.document,
        source: 'readme',
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
