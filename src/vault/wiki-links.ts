export interface RawLink {
  raw: string;       // the part to resolve (path or bare name)
  display: string | null;  // pipe alias display text, if any
}

/**
 * Extract wiki links from markdown, ignoring code blocks and embedded images.
 */
export function extractWikiLinks(markdown: string): RawLink[] {
  const links: RawLink[] = [];

  // Remove code blocks first
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '');

  // Match [[...]] but not ![[...]]
  const pattern = /(?<!!)\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = pattern.exec(withoutCode)) !== null) {
    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    if (pipeIndex !== -1) {
      links.push({
        raw: inner.substring(0, pipeIndex),
        display: inner.substring(pipeIndex + 1),
      });
    } else {
      links.push({ raw: inner, display: null });
    }
  }

  return links;
}

/**
 * Build a lookup table mapping filename stems to their full paths.
 */
export function buildStemLookup(allPaths: string[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const p of allPaths) {
    const stem = p.replace(/\.md$/, '').split('/').pop()!;
    const existing = lookup.get(stem) ?? [];
    existing.push(p);
    lookup.set(stem, existing);
  }
  return lookup;
}

/**
 * Rewrite every wiki-link targeting `oldPath` (as either a bare stem or a
 * path-qualified reference) to point at `newPath`.
 *
 * `oldPath` and `newPath` are vault-relative `.md` paths — e.g.
 * `"notes/BMW.md"` and `"cars/BMW & Audi.md"`. The function handles three
 * match shapes in priority order:
 *
 *   1. Bare-stem reference `[[BMW]]`           → `[[BMW & Audi]]`
 *      Preserves the author's shortest-path style. Output uses the new
 *      basename, not the new folder-qualified path.
 *
 *   2. Path-qualified reference without `.md` `[[notes/BMW]]`
 *                                              → `[[cars/BMW & Audi]]`
 *      Emits the full new path (no `.md`) so a cross-folder rename works
 *      end-to-end without leaving the link pointing at a defunct folder.
 *
 *   3. Path-qualified reference with `.md` `[[notes/BMW.md]]`
 *                                              → `[[cars/BMW & Audi]]`
 *      Rare but canonical Obsidian syntax; normalised to without-`.md` form
 *      for consistency with (2).
 *
 * Preserves the four decoration forms in all cases:
 *   `[[x|alias]]`, `![[x]]`, `[[x#heading]]`, `[[x^block]]`.
 */
export function rewriteWikiLinks(
  markdown: string,
  oldPath: string,
  newPath: string,
): { text: string; occurrences: number } {
  const oldStem = oldPath.replace(/\.md$/, '').split('/').pop() ?? '';
  const oldPathNoExt = oldPath.replace(/\.md$/, '');
  const newStem = newPath.replace(/\.md$/, '').split('/').pop() ?? '';
  const newPathNoExt = newPath.replace(/\.md$/, '');

  let occurrences = 0;
  // Groups: 1=optional !, 2=stem, 3=optional # or ^ suffix, 4=optional | alias.
  const pattern = /(!?)\[\[([^\]|#^\n]+?)((?:#|\^)[^\]|\n]+)?(\|[^\]\n]*)?\]\]/g;
  const text = markdown.replace(pattern, (full, bang, stem, suffix, alias) => {
    const trimmed = stem.trim();
    let replacement: string | null = null;
    if (trimmed === oldStem) {
      // Bare-stem match: only rewrite when the stem itself changed. A
      // cross-folder-only move leaves bare-stem references resolving
      // correctly on their own.
      if (oldStem !== newStem) replacement = newStem;
    } else if (trimmed === oldPathNoExt || trimmed === oldPath) {
      // Path-qualified match: rewrite when the full path changed (folder
      // and/or basename).
      if (oldPathNoExt !== newPathNoExt) replacement = newPathNoExt;
    }
    if (replacement === null) return full;
    occurrences++;
    return `${bang}[[${replacement}${suffix ?? ''}${alias ?? ''}]]`;
  });
  return { text, occurrences };
}

/**
 * Resolve a wiki link reference to a vault-relative path.
 * Returns null for unresolvable links (these become stub nodes).
 *
 * `referrerPath` (vault-relative, optional): when provided, prefer a
 * candidate in the same folder as the referrer over arbitrary alternatives.
 * Mirrors Obsidian's own resolver, which prefers same-folder-then-mtime.
 * mtime-tiebreak is a follow-up — it requires DB plumbing into the parser.
 *
 * `warnedAmbiguous` (optional): a Set the caller threads through one
 * `parseVault` invocation. The first time an ambiguous stem fires, we
 * emit the warning and add it to the set; subsequent occurrences in the
 * same parse pass stay silent. Drops ~1224 stderr lines on a 10k vault to
 * one line per distinct ambiguous target.
 */
export function resolveLink(
  raw: string,
  stemLookup: Map<string, string[]>,
  allPathsSet?: Set<string>,
  referrerPath?: string,
  warnedAmbiguous?: Set<string>,
): string | null {
  // Path-qualified: try direct match first
  const withMd = raw.endsWith('.md') ? raw : raw + '.md';
  const pathSet = allPathsSet ?? new Set([...stemLookup.values()].flat());
  if (pathSet.has(withMd)) {
    return withMd;
  }

  // Bare name: look up stem
  const stem = raw.split('/').pop()!;
  const candidates = stemLookup.get(stem);
  if (!candidates || candidates.length === 0) {
    return null;  // stub node
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  // Ambiguous — prefer path-qualified match if the raw includes a directory
  if (raw.includes('/')) {
    const match = candidates.find(c => c.startsWith(raw.replace(/\.md$/, '')));
    if (match) return match;
  }

  // V2: prefer same-folder candidate before falling back to first match.
  // Matches Obsidian UI's resolver behaviour for ambiguous stems.
  if (referrerPath) {
    const refDir = referrerPath.split('/').slice(0, -1).join('/');
    const sameFolder = candidates.find((c) => {
      const candDir = c.split('/').slice(0, -1).join('/');
      return candDir === refDir;
    });
    if (sameFolder) return sameFolder;
  }

  // V1: dedup the warning across one parse pass — emit once per stem.
  if (!warnedAmbiguous?.has(raw)) {
    console.warn(`Ambiguous wiki link [[${raw}]]: ${candidates.join(', ')}. Using first match.`);
    warnedAmbiguous?.add(raw);
  }
  return candidates[0];
}
