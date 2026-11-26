import { logger } from '../util/logger.js';

export interface RawLink {
  raw: string;       // the part to resolve (path or bare name)
  display: string | null;  // pipe alias display text, if any
  /** True for a transclusion `![[...]]`. Absent for plain links. */
  embed?: boolean;
}

/**
 * Remove fenced code blocks (``` and ~~~) and inline code spans. Shared by
 * every extractor that must ignore code: wiki links, inline tags, Dataview
 * fields. Removed spans are replaced with a single space so text on either
 * side doesn't fuse into a new token.
 */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

/**
 * Extract wiki links from markdown, ignoring code blocks. Embeds
 * (`![[Note]]`) are returned too, flagged `embed: true` — Obsidian counts an
 * embedded note as a link (backlinks, graph). Whether a target is a note or
 * an attachment (`![[diagram.png]]`) is decided at resolution time; see
 * `isAttachmentLink`.
 */
export function extractWikiLinks(markdown: string): RawLink[] {
  const links: RawLink[] = [];
  const withoutCode = stripCode(markdown);

  const pattern = /(!?)\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = pattern.exec(withoutCode)) !== null) {
    const inner = match[2]!;
    const pipeIndex = inner.indexOf('|');
    const link: RawLink = pipeIndex !== -1
      ? { raw: inner.substring(0, pipeIndex), display: inner.substring(pipeIndex + 1) }
      : { raw: inner, display: null };
    if (match[1] === '!') link.embed = true;
    links.push(link);
  }

  return links;
}

/**
 * File extensions Obsidian treats as attachments (images, audio, video,
 * PDF, canvas/bases, common office/data files). A link whose target ends in
 * one of these points at a file, not a note, so it must not produce a
 * note-graph edge or a `_stub/<name>.md` placeholder. A curated list rather
 * than "anything after a dot" so dotted note names (`v1.2 release`,
 * `J.R.R. Tolkien`) still resolve as notes.
 */
const ATTACHMENT_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico',
  // audio
  'mp3', 'wav', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'aac', '3gp', 'webm',
  // video
  'mp4', 'ogv', 'mov', 'mkv', 'avi', 'm4v',
  // documents / other Obsidian file types
  'pdf', 'canvas', 'base',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub',
  'csv', 'tsv', 'json', 'txt', 'zip',
]);

/**
 * True when a link target (bare, without `#heading` / `^block` / `|alias`)
 * names a non-markdown attachment, e.g. `diagram.png` or `files/spec.pdf`.
 */
export function isAttachmentLink(target: string): boolean {
  const name = target.trim().split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return ATTACHMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
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
  if (candidates && candidates.length > 0) {
    return pickCandidate(raw, candidates, false, referrerPath, warnedAmbiguous);
  }

  // Obsidian resolves links case-insensitively (`[[note]]` → `Note.md`).
  // Exact-case matches above always win; these fallbacks only fire when
  // nothing matched with the author's casing.
  const ciPath = lowerIndex(pathSet).get(withMd.toLowerCase());
  if (ciPath) {
    return pickCandidate(raw, ciPath, true, referrerPath, warnedAmbiguous);
  }
  const ciStem = lowerIndex(stemLookup).get(stem.toLowerCase());
  if (ciStem) {
    return pickCandidate(raw, ciStem, true, referrerPath, warnedAmbiguous);
  }
  return null; // stub node
}

/**
 * Lower-cased view of a stem lookup or path set, cached per source object so
 * one parse pass builds it once. Values keep their original casing.
 */
const lowerIndexCache = new WeakMap<object, Map<string, string[]>>();
function lowerIndex(source: Map<string, string[]> | Set<string>): Map<string, string[]> {
  const cached = lowerIndexCache.get(source);
  if (cached) return cached;
  const out = new Map<string, string[]>();
  const add = (key: string, paths: string[]): void => {
    if (paths.length === 0) return;
    const k = key.toLowerCase();
    const list = out.get(k);
    if (list) list.push(...paths);
    else out.set(k, [...paths]);
  };
  if (source instanceof Set) {
    for (const p of source) add(p, [p]);
  } else {
    for (const [stem, paths] of source) add(stem, paths);
  }
  lowerIndexCache.set(source, out);
  return out;
}

/**
 * Choose among the notes a link could mean. One candidate → it. Several →
 * path-qualified prefix match, then same folder as the referrer, then the
 * first match with a (deduplicated) ambiguity warning.
 */
function pickCandidate(
  raw: string,
  candidates: string[],
  caseInsensitive: boolean,
  referrerPath?: string,
  warnedAmbiguous?: Set<string>,
): string {
  if (candidates.length === 1) {
    return candidates[0]!;
  }

  // Ambiguous — prefer path-qualified match if the raw includes a directory
  if (raw.includes('/')) {
    const prefix = raw.replace(/\.md$/, '');
    const match = caseInsensitive
      ? candidates.find((c) => c.toLowerCase().startsWith(prefix.toLowerCase()))
      : candidates.find((c) => c.startsWith(prefix));
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
    logger.warn(`Ambiguous wiki link [[${raw}]]: ${candidates.join(', ')}. Using first match.`, {
      link: raw,
      candidates,
    });
    warnedAmbiguous?.add(raw);
  }
  return candidates[0]!;
}
