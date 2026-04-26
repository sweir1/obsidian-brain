/**
 * v1.7.5: model-metadata overrides — user-controlled, survives `npm update`.
 *
 * Reads / writes `~/.config/obsidian-brain/model-overrides.json` (XDG-
 * compliant; see user-config.ts). Each override is a partial patch on top
 * of the resolved metadata for a model id — set just `maxTokens`, just
 * `queryPrefix`, or any combination. Omitted fields keep the underlying
 * (cache → seed → HF → ...) value.
 *
 * File shape (v1):
 *   {
 *     "$version": 1,
 *     "models": {
 *       "MongoDB/mdbr-leaf-ir": { "maxTokens": 1024 },
 *       "intfloat/e5-mistral-7b-instruct": {
 *         "queryPrefix": "Custom: ",
 *         "documentPrefix": ""
 *       }
 *     }
 *   }
 *
 * Bad shape / missing file → empty map + stderr warning. Resolver falls
 * through to the next layer; we never crash. Validation rejects entries
 * with non-positive maxTokens, non-string prefixes, etc. — the user
 * gets a stderr line per bad entry but the rest of the file still loads.
 *
 * Override CHANGES are picked up on next process boot. The CLI
 * `models override <id>` writes to this file AND clears the in-process
 * cache so a long-running server picks them up via `_resetOverridesCache()`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getOverridesPath } from './user-config.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/overrides.ts');

export interface ModelOverride {
  maxTokens?: number;
  queryPrefix?: string | null;
  documentPrefix?: string | null;
}

interface OverrideFile {
  $version: 1;
  models: Record<string, ModelOverride>;
}

const SUPPORTED_VERSION = 1;

let cached: Map<string, ModelOverride> | null = null;

/** Reset in-process cache (tests + CLI write-then-read flow). */
export function _resetOverridesCache(): void {
  cached = null;
}

/**
 * Validate a single entry, returning the cleaned shape or null on
 * rejection. Permissive: an entry with one bad field plus one good
 * field still keeps the good field — drops only the bad one.
 */
function validateEntry(modelId: string, raw: unknown): ModelOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: ModelOverride = {};
  let hasField = false;

  if ('maxTokens' in r) {
    if (
      typeof r.maxTokens === 'number' &&
      Number.isFinite(r.maxTokens) &&
      r.maxTokens > 0
    ) {
      out.maxTokens = Math.floor(r.maxTokens);
      hasField = true;
    } else {
      process.stderr.write(
        `obsidian-brain: model-overrides: ${modelId}.maxTokens must be a positive finite number — dropping\n`,
      );
    }
  }
  for (const key of ['queryPrefix', 'documentPrefix'] as const) {
    if (key in r) {
      const val = r[key];
      if (val === null || typeof val === 'string') {
        out[key] = val;
        hasField = true;
      } else {
        process.stderr.write(
          `obsidian-brain: model-overrides: ${modelId}.${key} must be string|null — dropping\n`,
        );
      }
    }
  }

  return hasField ? out : null;
}

/**
 * Load overrides from disk once per process. Subsequent calls return the
 * cached map. Empty map on any load failure.
 */
export function loadOverrides(): Map<string, ModelOverride> {
  if (cached !== null) return cached;
  cached = new Map();

  const path = getOverridesPath();
  if (!existsSync(path)) return cached;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `obsidian-brain: model-overrides: invalid JSON at ${path} (${(err as Error).message ?? 'parse error'}) — ignoring\n`,
    );
    return cached;
  }

  if (!parsed || typeof parsed !== 'object') {
    process.stderr.write(
      `obsidian-brain: model-overrides: top-level value at ${path} is not an object — ignoring\n`,
    );
    return cached;
  }

  const file = parsed as Partial<OverrideFile>;
  if (file.$version !== SUPPORTED_VERSION) {
    process.stderr.write(
      `obsidian-brain: model-overrides: unsupported $version ${file.$version ?? '?'} (expected ${SUPPORTED_VERSION}) — ignoring\n`,
    );
    return cached;
  }
  if (!file.models || typeof file.models !== 'object') {
    return cached;
  }

  for (const [id, raw] of Object.entries(file.models)) {
    const validated = validateEntry(id, raw);
    if (validated) cached.set(id, validated);
  }
  return cached;
}

/**
 * Write or update a single override entry; merges with any existing
 * fields for that model id (so calling with `{maxTokens: 1024}` doesn't
 * wipe a previously-set queryPrefix). Resets the in-process cache so
 * subsequent `loadOverrides()` calls in the same process pick up the
 * change.
 */
export function saveOverride(modelId: string, patch: ModelOverride): void {
  const path = getOverridesPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing: OverrideFile = existsSync(path)
    ? safeReadOrEmpty(path)
    : { $version: SUPPORTED_VERSION, models: {} };
  existing.models[modelId] = { ...existing.models[modelId], ...patch };
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  _resetOverridesCache();
}

/**
 * Remove an override (or one of its fields). Returns true if the entry
 * existed and was modified, false if no-op.
 */
export function removeOverride(
  modelId: string,
  field?: keyof ModelOverride,
): boolean {
  const path = getOverridesPath();
  if (!existsSync(path)) return false;
  const existing = safeReadOrEmpty(path);
  if (!existing.models[modelId]) return false;
  if (field) {
    delete existing.models[modelId][field];
    if (Object.keys(existing.models[modelId]).length === 0) {
      delete existing.models[modelId];
    }
  } else {
    delete existing.models[modelId];
  }
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  _resetOverridesCache();
  return true;
}

function safeReadOrEmpty(path: string): OverrideFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.$version === SUPPORTED_VERSION) {
      return parsed as OverrideFile;
    }
  } catch {
    // fall through
  }
  return { $version: SUPPORTED_VERSION, models: {} };
}
