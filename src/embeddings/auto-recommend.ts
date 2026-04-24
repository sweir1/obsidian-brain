/**
 * First-boot preset auto-recommendation.
 *
 * When neither EMBEDDING_MODEL nor EMBEDDING_PRESET is set AND the DB has no
 * stored `embedding_model` metadata, this module:
 *   1. Walks the vault via collectMarkdownFiles.
 *   2. Samples the first ~2 KB of each note.
 *   3. Unicode-block classifies: if >5% of sampled chars fall in any non-Latin
 *      block (CJK, Cyrillic, Arabic, Devanagari, Hebrew, Thai) → multilingual.
 *   4. Picks 'english' (Latin-only) or 'multilingual' (non-Latin/mixed).
 *   5. Logs the rationale to stderr and returns the chosen preset name.
 *
 * The caller (bootstrap or server init) persists the result so subsequent
 * boots see a stored embedding_model and skip the auto-recommend path.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { EmbeddingPresetName } from './presets.js';

const SAMPLE_BYTES = 2048;

/** Unicode block ranges considered non-Latin for the multilingual heuristic. */
const NON_LATIN_RANGES: [number, number][] = [
  [0x3000, 0x9fff],   // CJK Symbols + CJK Unified Ideographs (inc. extensions)
  [0x0400, 0x04ff],   // Cyrillic
  [0x0600, 0x06ff],   // Arabic
  [0x0900, 0x097f],   // Devanagari
  [0x0590, 0x05ff],   // Hebrew
  [0x0e00, 0x0e7f],   // Thai
];

/** Returns true if the code point falls in any non-Latin block. */
function isNonLatin(cp: number): boolean {
  for (const [lo, hi] of NON_LATIN_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

/** Walk vault for .md files, mirroring parser.ts collectMarkdownFiles. */
async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(vaultPath, relPath)));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }
  return results;
}

/**
 * Classify vault language by sampling markdown files.
 * Returns fraction of sampled characters that are non-Latin.
 */
async function sampleVaultNonLatinFraction(vaultPath: string): Promise<number> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  if (mdPaths.length === 0) return 0;

  let totalChars = 0;
  let nonLatinChars = 0;

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    let raw: string;
    try {
      // Read only first SAMPLE_BYTES worth (we slice after decode)
      const buf = await readFile(absPath);
      raw = buf.slice(0, SAMPLE_BYTES).toString('utf-8');
    } catch {
      continue;
    }
    for (const char of raw) {
      const cp = char.codePointAt(0) ?? 0;
      // Skip control/whitespace — they're not informative for language detection
      if (cp < 0x0020) continue;
      totalChars++;
      if (isNonLatin(cp)) nonLatinChars++;
    }
  }

  if (totalChars === 0) return 0;
  return nonLatinChars / totalChars;
}

export interface AutoRecommendResult {
  preset: EmbeddingPresetName;
  reason: string;
  skipped: boolean;
}

/**
 * Run the first-boot preset auto-recommendation.
 *
 * Returns immediately (skipped=true) if:
 *   - EMBEDDING_MODEL or EMBEDDING_PRESET is set in env, OR
 *   - storedEmbeddingModel is truthy (DB already has a model recorded).
 *
 * Otherwise walks the vault, classifies, picks a preset, logs to stderr,
 * and returns the recommendation.
 */
export async function autoRecommendPreset(
  env: NodeJS.ProcessEnv,
  vaultPath: string,
  storedEmbeddingModel: string | undefined,
): Promise<AutoRecommendResult> {
  // Skip if user has explicit configuration.
  if ((env.EMBEDDING_MODEL && env.EMBEDDING_MODEL.trim()) ||
      (env.EMBEDDING_PRESET && env.EMBEDDING_PRESET.trim())) {
    return { preset: 'english', reason: 'explicit env var set', skipped: true };
  }

  // Skip if DB already has a stored model (not first boot).
  if (storedEmbeddingModel) {
    return { preset: 'english', reason: 'stored embedding_model present', skipped: true };
  }

  // Walk vault and classify.
  const fraction = await sampleVaultNonLatinFraction(vaultPath);
  const THRESHOLD = 0.05; // 5% non-Latin chars triggers multilingual

  let preset: EmbeddingPresetName;
  let rationale: string;

  if (fraction > THRESHOLD) {
    preset = 'multilingual';
    rationale = `${(fraction * 100).toFixed(1)}% non-Latin characters detected`;
  } else {
    preset = 'english';
    rationale = fraction === 0
      ? 'no non-Latin characters detected'
      : `${(fraction * 100).toFixed(1)}% non-Latin characters (below 5% threshold)`;
  }

  const reason = `vault scan (${rationale})`;
  process.stderr.write(
    `obsidian-brain: auto-recommended preset "${preset}" based on vault scan — ` +
    `set EMBEDDING_PRESET explicitly to override\n`,
  );

  return { preset, reason, skipped: false };
}
