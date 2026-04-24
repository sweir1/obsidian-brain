/**
 * Named presets for the transformers.js embedding model.
 *
 * Precedence (resolveEmbeddingModel):
 *   1. EMBEDDING_MODEL (raw HF model id — power-user path)
 *   2. EMBEDDING_PRESET (preset name → model id)
 *   3. default: 'english' preset (Xenova/bge-small-en-v1.5)
 *
 * Preset tiers:
 *   - english:              34 MB q8, 384d, asym, English only (default)
 *   - english-fast:         17 MB q8, 384d, sym,  English only (fastest)
 *   - english-quality:     110 MB q8, 768d, asym, English only (highest quality)
 *   - multilingual:        135 MB q8, 384d, asym, multilingual E5-small
 *   - multilingual-quality: 279 MB q8, 768d, asym, multilingual E5-base
 *   - multilingual-ollama:  via Ollama bge-m3, 1024d, sym, multilingual (recommended if Ollama available)
 *
 * The E5 `query:` / `passage:` prefixes are mandatory for multilingual and
 * multilingual-quality models and are applied automatically by
 * `getTransformersPrefix` in embedder.ts.
 *
 * Deprecated aliases (DEPRECATED_PRESET_ALIASES):
 *   - fastest  → english-fast    (pure rename, same model)
 *   - balanced → english         (MODEL CHANGE: all-MiniLM-L6-v2 dropped)
 */
export const EMBEDDING_PRESETS = {
  'english':              { model: 'Xenova/bge-small-en-v1.5',       sizeMb:  34,  dim: 384,  lang: 'en',           symmetric: false },
  'english-fast':         { model: 'Xenova/paraphrase-MiniLM-L3-v2', sizeMb:  17,  dim: 384,  lang: 'en',           symmetric: true  },
  'english-quality':      { model: 'Xenova/bge-base-en-v1.5',        sizeMb: 110,  dim: 768,  lang: 'en',           symmetric: false },
  'multilingual':         { model: 'Xenova/multilingual-e5-small',   sizeMb: 135,  dim: 384,  lang: 'multilingual', symmetric: false },
  'multilingual-quality': { model: 'Xenova/multilingual-e5-base',    sizeMb: 279,  dim: 768,  lang: 'multilingual', symmetric: false },
  'multilingual-ollama':  { model: 'bge-m3',                         sizeMb: null, dim: 1024, lang: 'multilingual', symmetric: true  },
} as const;

export type EmbeddingPresetName = keyof typeof EMBEDDING_PRESETS;

/**
 * Deprecated preset aliases. On match, resolveEmbeddingModel emits a one-boot
 * warning to stderr and resolves to the canonical preset name.
 *
 * - fastest  → english-fast:  pure rename, same model (paraphrase-MiniLM-L3-v2).
 * - balanced → english:       MODEL CHANGE — all-MiniLM-L6-v2 dropped; resolves
 *                             to bge-small-en-v1.5. Vault will re-embed once.
 */
export const DEPRECATED_PRESET_ALIASES: Record<string, EmbeddingPresetName> = {
  fastest:  'english-fast',
  balanced: 'english',
};

/** Track which alias warnings have been emitted this process lifetime. */
const _warnedAliases = new Set<string>();

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
  return preset.model;
}

/**
 * Reset the alias-warning deduplication set. Exposed for tests only — do NOT
 * call in production code.
 */
export function _resetAliasWarnings(): void {
  _warnedAliases.clear();
}
