/**
 * Named presets — friendly names that map to a HF model id + provider.
 *
 * Precedence (resolveEmbeddingModel):
 *   1. EMBEDDING_MODEL (raw HF model id — power-user path)
 *   2. EMBEDDING_PRESET (preset name → model id)
 *   3. default: 'english' preset (Xenova/bge-small-en-v1.5)
 *
 * v1.7.5: per-preset metadata (dim, max_tokens, query/document prefixes,
 * symmetry, on-disk size) is NO LONGER stored here. It's resolved at runtime
 * via the metadata-resolver chain (cache → bundled seed → HF API → safe
 * defaults). This file's only responsibility is the friendly-name → model-id
 * + provider mapping.
 *
 * The full per-preset metadata (including MTEB scores, license, language
 * coverage, and known issues) lives in `docs/models.md`.
 *
 * Deprecated aliases (DEPRECATED_PRESET_ALIASES):
 *   - fastest  → english-fast
 *   - balanced → english         (MODEL CHANGE: all-MiniLM-L6-v2 dropped)
 */
export const EMBEDDING_PRESETS = {
  'english':              { model: 'Xenova/bge-small-en-v1.5',     provider: 'transformers' as const },
  'english-fast':         { model: 'MongoDB/mdbr-leaf-ir',         provider: 'transformers' as const },
  'english-quality':      { model: 'Xenova/bge-base-en-v1.5',      provider: 'transformers' as const },
  'multilingual':         { model: 'Xenova/multilingual-e5-small', provider: 'transformers' as const },
  'multilingual-quality': { model: 'Xenova/multilingual-e5-base',  provider: 'transformers' as const },
  'multilingual-ollama':  { model: 'qwen3-embedding:0.6b',         provider: 'ollama'       as const },
} as const;

export type EmbeddingPresetName = keyof typeof EMBEDDING_PRESETS;

/**
 * Deprecated preset aliases. On match, resolveEmbeddingModel emits a one-boot
 * warning to stderr and resolves to the canonical preset name.
 *
 * - fastest  → english-fast:  alias rename. v1.7.4 also swapped english-fast's
 *                             underlying model from Xenova/paraphrase-MiniLM-L3-v2
 *                             to MongoDB/mdbr-leaf-ir (Apache-2.0, retrieval-tuned
 *                             23M-param distillation of mxbai-embed-large-v1, 22 MB,
 *                             768d (post-Dense projection), asymmetric).
 *                             Vault will re-embed once.
 * - balanced → english:       MODEL CHANGE — all-MiniLM-L6-v2 dropped; resolves
 *                             to bge-small-en-v1.5. Vault will re-embed once.
 */
export const DEPRECATED_PRESET_ALIASES: Record<string, EmbeddingPresetName> = {
  fastest:  'english-fast',
  balanced: 'english',
};

/** Track which alias warnings have been emitted this process lifetime. */
const _warnedAliases = new Set<string>();

/** Track whether the multilingual-quality known-bug warning has been emitted this process lifetime. */
let _warnedMultilingualQualityBug = false;

export function resolveEmbeddingModel(env: NodeJS.ProcessEnv): string {
  // Precedence: EMBEDDING_MODEL > EMBEDDING_PRESET > default (english)
  if (env.EMBEDDING_MODEL && env.EMBEDDING_MODEL.trim()) {
    return env.EMBEDDING_MODEL.trim();
  }
  const presetName = (env.EMBEDDING_PRESET ?? 'english').trim().toLowerCase();

  // Check for deprecated alias before the canonical lookup.
  if (presetName in DEPRECATED_PRESET_ALIASES) {
    const canonical = DEPRECATED_PRESET_ALIASES[presetName];
    if (!_warnedAliases.has(presetName)) {
      _warnedAliases.add(presetName);
      if (presetName === 'balanced') {
        process.stderr.write(
          `obsidian-brain: EMBEDDING_PRESET="balanced" is deprecated. ` +
          `It now resolves to "english" (Xenova/bge-small-en-v1.5) — ` +
          `a different model than the old Xenova/all-MiniLM-L6-v2. ` +
          `Your vault will re-embed once on next boot. ` +
          `To keep the old model explicitly, set EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2.\n`,
        );
      } else {
        process.stderr.write(
          `obsidian-brain: EMBEDDING_PRESET="${presetName}" is deprecated and has been renamed ` +
          `to "${canonical}". Please update your configuration.\n`,
        );
      }
    }
    return EMBEDDING_PRESETS[canonical].model;
  }

  const preset = EMBEDDING_PRESETS[presetName as EmbeddingPresetName];
  if (!preset) {
    const valid = Object.keys(EMBEDDING_PRESETS).join(', ');
    throw new Error(
      `Unknown EMBEDDING_PRESET='${presetName}'. Valid presets: ${valid}. ` +
      `Or set EMBEDDING_MODEL to a specific HF model id (power-user path).`,
    );
  }

  if (presetName === 'multilingual-quality' && !_warnedMultilingualQualityBug) {
    _warnedMultilingualQualityBug = true;
    process.stderr.write(
      `obsidian-brain: ⚠ EMBEDDING_PRESET="multilingual-quality" (Xenova/multilingual-e5-base) has a known token_type_ids ` +
      `bug in transformers.js for inputs > ~400 words (transformers.js#267). Notes that hit this bug are recorded in the ` +
      `failed_chunks table and surfaced via the index_status tool. For lossless multilingual quality, prefer ` +
      `EMBEDDING_PRESET=multilingual-ollama (qwen3-embedding:0.6b via Ollama, 32768 ctx, MTEB multi 64.3 vs e5-base's 59.0). ` +
      `For smaller-but-tolerant transformers.js: EMBEDDING_PRESET=multilingual.\n`,
    );
  }

  return preset.model;
}

/**
 * Reset the alias-warning deduplication set. Exposed for tests only — do NOT
 * call in production code.
 */
export function _resetAliasWarnings(): void {
  _warnedAliases.clear();
}

/**
 * Resolve which embedding provider to use, considering env overrides and the
 * preset's declared provider.
 *
 * Precedence:
 *   1. EMBEDDING_PROVIDER (explicit user override — always wins)
 *   2. EMBEDDING_MODEL (power-user raw model id — assume transformers)
 *   3. Preset's declared provider (e.g. multilingual-ollama → 'ollama')
 *   4. Default: 'transformers'
 */
export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv): 'transformers' | 'ollama' {
  // Explicit user override always wins. Unknown values are a typo / config bug
  // and should fail loudly with a clear list of valid options — preserves the
  // pre-v1.7.2 factory.ts behaviour (don't silently coerce 'openai' → default).
  if (env.EMBEDDING_PROVIDER && env.EMBEDDING_PROVIDER.trim()) {
    const v = env.EMBEDDING_PROVIDER.trim().toLowerCase();
    if (v === 'transformers' || v === 'ollama') return v;
    throw new Error(
      `Unknown EMBEDDING_PROVIDER='${env.EMBEDDING_PROVIDER}'. ` +
      `Valid providers: transformers, ollama.`,
    );
  }
  // Power-user EMBEDDING_MODEL — assume transformers unless they explicitly set ollama.
  if (env.EMBEDDING_MODEL) return 'transformers';
  // Otherwise the preset's declared provider governs.
  const presetName = (env.EMBEDDING_PRESET ?? 'english').trim().toLowerCase();
  const canonical = (DEPRECATED_PRESET_ALIASES[presetName] ?? presetName) as EmbeddingPresetName;
  const preset = EMBEDDING_PRESETS[canonical];
  return preset?.provider ?? 'transformers';
}

/**
 * Reset the multilingual-quality known-bug warning flag. Exposed for tests
 * only — do NOT call in production code.
 */
export function _resetMultilingualQualityWarning(): void {
  _warnedMultilingualQualityBug = false;
}
