/**
 * Single source of truth for the named embedding presets.
 *
 * **What lives here:**
 *   - `EMBEDDING_PRESETS`   — the friendly-name → (model, provider) registry.
 *   - `DEFAULT_PRESET`      — name of the preset that applies when neither
 *                             EMBEDDING_PRESET nor EMBEDDING_MODEL is set.
 *   - `DEFAULT_OLLAMA_MODEL`— the Ollama model used as a fallback when the
 *                             user explicitly sets EMBEDDING_PROVIDER=ollama
 *                             without naming a model or a matching preset.
 *   - `resolvePresetConfig` — **the single resolver every consumer must call**.
 *                             Returns `{ provider, model, presetName, source }`
 *                             atomically so it's structurally impossible to
 *                             desync provider and model (the v1.7.5→v1.7.7
 *                             multilingual-ollama bug class).
 *   - `resolveEmbeddingProvider` / `resolveEmbeddingModel` — back-compat thin
 *                             wrappers around `resolvePresetConfig`. Pre-v1.7.8
 *                             callers (tests, auto-recommend, cli/models)
 *                             keep working unchanged.
 *
 * **What does NOT live here:**
 *   - Per-model metadata (dim, max_tokens, prefixes). That's resolved at
 *     runtime via the metadata-resolver chain (cache → bundled seed → HF →
 *     defaults). See `src/embeddings/metadata-resolver.ts`.
 *   - Display-only docs content (preset descriptions, MTEB scores, license,
 *     language coverage). That lives in `docs/models.md` and is currently
 *     hand-maintained — codegen is a separate concern.
 *
 * **Precedence in `resolvePresetConfig` (highest first):**
 *   1. EMBEDDING_MODEL set → use it raw; provider = EMBEDDING_PROVIDER if set,
 *                            else `transformers` (legacy default for raw model id).
 *   2. EMBEDDING_PROVIDER + EMBEDDING_PRESET set with mismatched provider →
 *      provider override wins, preset's model carried over, **mismatch warning
 *      emitted** so the (likely-incorrect) combo doesn't silently fail.
 *   3. EMBEDDING_PRESET set → preset's declared (provider, model) pair used
 *      atomically. Deprecated aliases (`fastest`, `balanced`) resolve to their
 *      canonical name with a one-shot warning.
 *   4. EMBEDDING_PROVIDER set without preset/model → use the provider-default
 *      model: `DEFAULT_OLLAMA_MODEL` for ollama, `DEFAULT_PRESET`'s model for
 *      transformers. (Pre-v1.7.8 the ollama-default was hardcoded inside
 *      factory.ts; v1.7.8 unifies it here.)
 *   5. Nothing set → `DEFAULT_PRESET` applies.
 */

import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/presets.ts');

// ─── Defaults — change in ONE place, every consumer follows ─────────────
export const DEFAULT_PRESET = 'english' as const;
export const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

// ─── Preset registry ────────────────────────────────────────────────────
export const EMBEDDING_PRESETS = {
  'english':              { model: 'Xenova/bge-small-en-v1.5',     provider: 'transformers' as const },
  'english-fast':         { model: 'MongoDB/mdbr-leaf-ir',         provider: 'transformers' as const },
  'english-quality':      { model: 'Xenova/bge-base-en-v1.5',      provider: 'transformers' as const },
  'multilingual':         { model: 'Xenova/multilingual-e5-small', provider: 'transformers' as const },
  'multilingual-quality': { model: 'Xenova/multilingual-e5-base',  provider: 'transformers' as const },
  'multilingual-ollama':  { model: 'qwen3-embedding:0.6b',         provider: 'ollama'       as const },
} as const;

export type EmbeddingPresetName = keyof typeof EMBEDDING_PRESETS;
export type EmbeddingProvider = 'transformers' | 'ollama';

/**
 * Deprecated preset aliases. On match, `resolvePresetConfig` emits a one-boot
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

// ─── Atomic resolver — everyone calls this ──────────────────────────────
export interface PresetConfig {
  provider: EmbeddingProvider;
  model: string;
  /** null when the user set EMBEDDING_MODEL directly (no preset chosen). */
  presetName: EmbeddingPresetName | null;
  source: 'env-model' | 'env-preset' | 'env-provider' | 'default';
}

/** One-shot warning trackers (process-lifetime). */
const _warnedAliases = new Set<string>();
let _warnedMultilingualQualityBug = false;
let _warnedProviderMismatch = false;

function _emitAliasWarning(rawName: string, canonical: EmbeddingPresetName): void {
  if (_warnedAliases.has(rawName)) return;
  _warnedAliases.add(rawName);
  if (rawName === 'balanced') {
    process.stderr.write(
      `obsidian-brain: EMBEDDING_PRESET="balanced" is deprecated. ` +
      `It now resolves to "english" (Xenova/bge-small-en-v1.5) — ` +
      `a different model than the old Xenova/all-MiniLM-L6-v2. ` +
      `Your vault will re-embed once on next boot. ` +
      `To keep the old model explicitly, set EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2.\n`,
    );
  } else {
    process.stderr.write(
      `obsidian-brain: EMBEDDING_PRESET="${rawName}" is deprecated and has been renamed ` +
      `to "${canonical}". Please update your configuration.\n`,
    );
  }
}

function _emitMultilingualQualityWarning(): void {
  if (_warnedMultilingualQualityBug) return;
  _warnedMultilingualQualityBug = true;
  process.stderr.write(
    `obsidian-brain: ⚠ EMBEDDING_PRESET="multilingual-quality" (Xenova/multilingual-e5-base) has a known token_type_ids ` +
    `bug in transformers.js for inputs > ~400 words (transformers.js#267). Notes that hit this bug are recorded in the ` +
    `failed_chunks table and surfaced via the index_status tool. For lossless multilingual quality, prefer ` +
    `EMBEDDING_PRESET=multilingual-ollama (qwen3-embedding:0.6b via Ollama, 32768 ctx, MTEB multi 64.3 vs e5-base's 59.0). ` +
    `For smaller-but-tolerant transformers.js: EMBEDDING_PRESET=multilingual.\n`,
  );
}

function _emitProviderMismatchWarning(
  override: EmbeddingProvider,
  presetName: EmbeddingPresetName,
  presetProvider: EmbeddingProvider,
  presetModel: string,
): void {
  if (_warnedProviderMismatch) return;
  _warnedProviderMismatch = true;
  process.stderr.write(
    `obsidian-brain: ⚠ EMBEDDING_PROVIDER='${override}' overrides ` +
    `EMBEDDING_PRESET='${presetName}' which declares provider='${presetProvider}'. ` +
    `Will attempt model='${presetModel}' on provider='${override}' — likely fails ` +
    `unless that model exists on the chosen provider. ` +
    `Either remove EMBEDDING_PROVIDER, switch to a preset that declares ` +
    `provider='${override}', or set EMBEDDING_MODEL explicitly.\n`,
  );
}

function _parseExplicitProvider(env: NodeJS.ProcessEnv): EmbeddingProvider | null {
  if (!env.EMBEDDING_PROVIDER || !env.EMBEDDING_PROVIDER.trim()) return null;
  const v = env.EMBEDDING_PROVIDER.trim().toLowerCase();
  if (v !== 'transformers' && v !== 'ollama') {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER='${env.EMBEDDING_PROVIDER}'. ` +
      `Valid providers: transformers, ollama.`,
    );
  }
  return v;
}

function _resolveCanonicalPreset(rawName: string): EmbeddingPresetName {
  if (rawName in DEPRECATED_PRESET_ALIASES) {
    const canonical = DEPRECATED_PRESET_ALIASES[rawName];
    _emitAliasWarning(rawName, canonical);
    return canonical;
  }
  if (rawName in EMBEDDING_PRESETS) {
    return rawName as EmbeddingPresetName;
  }
  const valid = Object.keys(EMBEDDING_PRESETS).join(', ');
  throw new Error(
    `Unknown EMBEDDING_PRESET='${rawName}'. Valid presets: ${valid}. ` +
    `Or set EMBEDDING_MODEL to a specific HF model id (power-user path).`,
  );
}

/**
 * The single resolver. Every consumer should call this — never re-implement
 * env-var precedence locally. Returns provider and model atomically so they
 * cannot desync (the bug class that hit `multilingual-ollama` pre-v1.7.8).
 */
export function resolvePresetConfig(env: NodeJS.ProcessEnv): PresetConfig {
  const explicitProvider = _parseExplicitProvider(env);

  // (1) Power-user path: EMBEDDING_MODEL set → use it raw.
  if (env.EMBEDDING_MODEL && env.EMBEDDING_MODEL.trim()) {
    return {
      provider: explicitProvider ?? 'transformers',
      model: env.EMBEDDING_MODEL.trim(),
      presetName: null,
      source: 'env-model',
    };
  }

  // (2/3/5) Preset path: env-set preset OR fall back to DEFAULT_PRESET.
  const userSetPreset = !!(env.EMBEDDING_PRESET && env.EMBEDDING_PRESET.trim());
  if (userSetPreset) {
    const rawName = env.EMBEDDING_PRESET!.trim().toLowerCase();
    const canonical = _resolveCanonicalPreset(rawName);
    if (canonical === 'multilingual-quality') _emitMultilingualQualityWarning();
    const preset = EMBEDDING_PRESETS[canonical];

    // No provider override → preset's declared (provider, model) pair.
    if (!explicitProvider) {
      return { provider: preset.provider, model: preset.model, presetName: canonical, source: 'env-preset' };
    }
    // Provider override matches preset → straightforward.
    if (explicitProvider === preset.provider) {
      return { provider: explicitProvider, model: preset.model, presetName: canonical, source: 'env-preset' };
    }
    // Provider override CONFLICTS with preset → warn, honor override on
    // provider, carry the preset's model anyway (likely fails at runtime,
    // but the warning explains why).
    _emitProviderMismatchWarning(explicitProvider, canonical, preset.provider, preset.model);
    return { provider: explicitProvider, model: preset.model, presetName: canonical, source: 'env-preset' };
  }

  // (4) Provider override without preset → use provider-default model.
  if (explicitProvider === 'ollama') {
    return { provider: 'ollama', model: DEFAULT_OLLAMA_MODEL, presetName: null, source: 'env-provider' };
  }
  if (explicitProvider === 'transformers') {
    const def = EMBEDDING_PRESETS[DEFAULT_PRESET];
    return { provider: 'transformers', model: def.model, presetName: DEFAULT_PRESET, source: 'env-provider' };
  }

  // (5) Nothing set → DEFAULT_PRESET.
  const def = EMBEDDING_PRESETS[DEFAULT_PRESET];
  return { provider: def.provider, model: def.model, presetName: DEFAULT_PRESET, source: 'default' };
}

// ─── Back-compat thin wrappers ──────────────────────────────────────────
// Pre-v1.7.8 callers (tests, auto-recommend, cli/models) keep working.
// New code should call `resolvePresetConfig` directly so the (provider,
// model) pair is observed atomically.

export function resolveEmbeddingModel(env: NodeJS.ProcessEnv): string {
  return resolvePresetConfig(env).model;
}

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  return resolvePresetConfig(env).provider;
}

// ─── Test-only helpers (do NOT call in production) ──────────────────────
export function _resetAliasWarnings(): void {
  _warnedAliases.clear();
}

export function _resetMultilingualQualityWarning(): void {
  _warnedMultilingualQualityBug = false;
}

export function _resetProviderMismatchWarning(): void {
  _warnedProviderMismatch = false;
}
