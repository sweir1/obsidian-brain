import type { ParsedNode } from '../../types.js';

/**
 * Minimum length (chars) of a fallback embedding text before we accept it.
 * Below this, the note has no meaningful identity to embed and we record it
 * as `'no-embeddable-content'` instead.
 */
export const MIN_FALLBACK_CHARS = 3;

/**
 * Build a synthetic embedding text for a note whose body produced zero chunks
 * (empty file, frontmatter-only, embeds-only, sub-`minChunkChars` body).
 * Combines title + tags + scalar frontmatter values + first 5 wikilink/embed
 * targets. Returns '' if nothing meaningful can be assembled — the caller
 * treats that as `'no-embeddable-content'`.
 */
export function buildTitleFallbackText(node: ParsedNode): string {
  const parts: string[] = [];
  if (node.title) parts.push(node.title);

  const fmTags = node.frontmatter.tags;
  const tags = Array.isArray(fmTags) ? (fmTags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (tags.length > 0) parts.push(tags.join(', '));

  for (const [key, val] of Object.entries(node.frontmatter)) {
    if (key === 'tags' || key.startsWith('_')) continue;
    if (typeof val === 'string' && val.trim()) parts.push(`${key}: ${val.trim()}`);
    else if (typeof val === 'number' || typeof val === 'boolean') parts.push(`${key}: ${val}`);
  }

  // Pull up to 5 wikilink/embed target names from the body so embeds-only
  // collector notes (`![[a.png]] ![[b.png]]`) still have searchable text.
  const linkRe = /!?\[\[([^\]|#^]+)/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(node.content)) !== null && links.length < 5) {
    const target = m[1].trim();
    if (target) links.push(target);
  }
  if (links.length > 0) parts.push(`Links: ${links.join(', ')}`);

  return parts.join('\n');
}
