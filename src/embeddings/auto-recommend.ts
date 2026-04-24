/**
 * Auto-recommend an embedding preset for the given vault.
 *
 * Wave A (Presets agent) owns the full implementation. This file provides
 * a minimal version so the CLI can compile and the `models recommend`
 * subcommand is functional before that agent's work lands.
 *
 * Heuristics:
 *   - Reads a sample of files to estimate language distribution.
 *   - If non-ASCII ratio > 5%: recommend `multilingual`.
 *   - Otherwise: recommend `english` (best quality for English vaults).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { EMBEDDING_PRESETS, type EmbeddingPresetName } from './presets.js';

export interface RecommendResult {
  preset: EmbeddingPresetName;
  model: string;
  rationale: string;
}

/**
 * Inspect the vault at `vaultPath` and return the best preset + rationale.
 *
 * @throws {Error} If vaultPath does not exist or cannot be read.
 */
export async function recommendPreset(
  vaultPath: string,
): Promise<RecommendResult> {
  // Sample up to 50 markdown files.
  const files = collectMdFiles(vaultPath, 50);

  if (files.length === 0) {
    // Empty vault — default to english.
    return {
      preset: 'english',
      model: EMBEDDING_PRESETS.english.model,
      rationale:
        'Vault is empty or contains no markdown files; defaulting to the english preset (Xenova/bge-small-en-v1.5).',
    };
  }

  let totalChars = 0;
  let nonAsciiChars = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      totalChars += content.length;
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) > 127) nonAsciiChars++;
      }
    } catch {
      // Skip unreadable files.
    }
  }

  const nonAsciiRatio = totalChars > 0 ? nonAsciiChars / totalChars : 0;

  if (nonAsciiRatio > 0.05) {
    return {
      preset: 'multilingual',
      model: EMBEDDING_PRESETS.multilingual.model,
      rationale:
        `Sampled ${files.length} files; ${(nonAsciiRatio * 100).toFixed(1)}% of characters are non-ASCII — ` +
        `recommending the multilingual preset (Xenova/multilingual-e5-small) for cross-language search.`,
    };
  }

  return {
    preset: 'english',
    model: EMBEDDING_PRESETS.english.model,
    rationale:
      `Sampled ${files.length} files; ${(nonAsciiRatio * 100).toFixed(1)}% non-ASCII (< 5% threshold) — ` +
      `recommending the english preset (Xenova/bge-small-en-v1.5) for best English search quality.`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectMdFiles(dir: string, max: number): string[] {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && results.length < max) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.startsWith('.')) continue; // skip hidden dirs / .obsidian
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (extname(entry).toLowerCase() === '.md') {
        results.push(full);
      }
    }
  }
  return results;
}
