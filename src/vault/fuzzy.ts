/**
 * Fuzzy text matching based on Levenshtein distance.
 *
 * Ported from aaronsb/obsidian-mcp-plugin's `src/utils/fuzzy-match.ts`, but
 * adapted to work on raw strings instead of line-indexed content. Whereas
 * aaronsb's version returned line numbers (because the Obsidian editor wants
 * to highlight lines), this version returns character offsets so the caller
 * can perform in-place substring substitution.
 *
 * Two-stage approach:
 *   1. Direct substring search (case-insensitive).
 *   2. If no exact hit, sliding-window Levenshtein over word groups.
 */

export interface FuzzyMatch {
  /** Character offset where the match begins (inclusive). */
  start: number;
  /** Character offset where the match ends (exclusive). */
  end: number;
  /** The substring of `haystack` that matched. */
  text: string;
  /** Similarity score in [0, 1]; 1 means exact (case-insensitive) match. */
  score: number;
}

/**
 * Classic Levenshtein distance. O(m*n) time, O(m*n) space. Fine for the
 * small window sizes we use (a few dozen characters at most).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const matrix: number[][] = [];
  for (let i = 0; i <= n; i++) matrix[i] = [i];
  for (let j = 0; j <= m; j++) matrix[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1,     // deletion
        );
      }
    }
  }
  return matrix[n][m];
}

/** Similarity in [0,1]; 1 means identical (case-insensitive). */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const d = levenshtein(a.toLowerCase(), b.toLowerCase());
  return 1 - d / max;
}

/**
 * Locate fuzzy occurrences of `needle` inside `haystack`.
 *
 * Returns all matches at or above `threshold`, sorted by score descending.
 * The caller is expected to enforce uniqueness (e.g. 1 result = good,
 * >1 = ambiguous, 0 = missing).
 */
export function fuzzyFind(
  haystack: string,
  needle: string,
  threshold: number = 0.7,
): FuzzyMatch[] {
  if (needle.length === 0) return [];

  const matches: FuzzyMatch[] = [];

  // Stage 1: exact (case-insensitive) substring. Report *all* occurrences so
  // the caller can detect ambiguity.
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let cursor = 0;
  while (cursor <= lowerHay.length - lowerNeedle.length) {
    const idx = lowerHay.indexOf(lowerNeedle, cursor);
    if (idx === -1) break;
    matches.push({
      start: idx,
      end: idx + needle.length,
      text: haystack.slice(idx, idx + needle.length),
      score: 1,
    });
    cursor = idx + needle.length;
  }
  if (matches.length > 0) {
    return matches.sort((a, b) => b.score - a.score);
  }

  // Stage 2: sliding window Levenshtein over word groups.
  //
  // We scan the haystack by lines to mirror aaronsb's original layout, but
  // translate line-local word offsets back into absolute character offsets.
  const needleWords = needle.trim().split(/\s+/).filter(Boolean);
  const needleLen = Math.max(1, needleWords.length);
  const lines = haystack.split('\n');

  let absLineStart = 0;
  for (const line of lines) {
    let bestLocal: { start: number; end: number; score: number } | undefined;

    // Split preserving offsets
    const wordRe = /\S+/g;
    const words: Array<{ text: string; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(line)) !== null) {
      words.push({ text: m[0], start: m.index });
    }

    // Windows of length [1, needleLen+2]
    const maxWindow = Math.min(words.length, needleLen + 2);
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= Math.min(words.length, start + maxWindow); end++) {
        const phrase = words.slice(start, end).map((w) => w.text).join(' ');
        const score = similarity(phrase, needle);
        if (!bestLocal || score > bestLocal.score) {
          const lastWord = words[end - 1];
          bestLocal = {
            start: words[start].start,
            end: lastWord.start + lastWord.text.length,
            score,
          };
        }
      }
    }

    if (bestLocal && bestLocal.score >= threshold) {
      const absStart = absLineStart + bestLocal.start;
      const absEnd = absLineStart + bestLocal.end;
      matches.push({
        start: absStart,
        end: absEnd,
        text: haystack.slice(absStart, absEnd),
        score: bestLocal.score,
      });
    }

    absLineStart += line.length + 1; // +1 for the split '\n'
  }

  return matches.sort((a, b) => b.score - a.score);
}
