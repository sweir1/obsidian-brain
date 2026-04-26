import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Catch dead links in README.md. Specifically:
 *
 *   - **Internal anchors** (`[text](#slug)`) — verify the slug matches a
 *     heading in README.md. This catches the v1.7.8 regression where the
 *     `## Recent releases` heading was deleted by the gen-readme-recent
 *     codegen and the table-of-contents `[Recent releases](#recent-releases)`
 *     link silently broke.
 *
 *   - **Relative paths** (`[text](docs/foo.md)`, `[text](LICENSE)`) — verify
 *     the file exists on disk relative to repo root. Catches typos and
 *     references to docs that were renamed/deleted without a README sweep.
 *
 *   - **Relative paths with anchors** (`[text](docs/foo.md#section)`) —
 *     verify file exists AND the anchor matches a heading in that file.
 *
 *   - **External URLs** (`https://`, `http://`, `mailto:`, `tel:`) — SKIP.
 *     Network-dependent, flaky in CI, and link-rot is a separate concern
 *     that needs a different cadence (weekly cron, not per-commit).
 *
 *   - **Code blocks** — links inside fenced ```code``` and inline `code`
 *     are stripped before parsing so example URLs don't get validated.
 *
 * docs/**.md broken links are already caught by `mkdocs build --strict`
 * (the `docs:build` step in preflight + ci.yml), so this suite stays
 * focused on README.md which mkdocs doesn't render.
 *
 * Slug algorithm mirrors GitHub's heading-anchor rule for the README's
 * actual usage: lowercase, strip non-(word|space|hyphen) chars, collapse
 * whitespace runs to single hyphens. Verified against the README's own
 * table-of-contents at the top of the file as the canonical fixture.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');

interface Link {
  text: string;
  url: string;
}

/**
 * Convert a heading text to its GitHub-flavoured anchor slug. Matches the
 * algorithm GitHub Pages and our existing TOC links rely on for README:
 *
 *   "Why obsidian-brain?"        → "why-obsidian-brain"
 *   "Companion plugin (optional)"→ "companion-plugin-optional"
 *   "Recent releases"            → "recent-releases"
 *
 * Rough Unicode-aware version of `\w` would be needed for non-ASCII
 * headings; README is currently English-only so ASCII `\w` is sufficient.
 * If we ever ship non-ASCII headings, revisit.
 */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip punctuation: ?, (), :, ., commas etc.
    .trim()
    .replace(/\s+/g, '-');
}

function extractHeadingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of markdown.split('\n')) {
    // ATX headings only: `#`, `##`, ..., `######`. Setext (=== / ---) ignored —
    // README doesn't use them.
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) slugs.add(githubSlug(m[2]));
  }
  return slugs;
}

function extractLinks(markdown: string): Link[] {
  // Strip fenced code blocks AND inline code first so example URLs in
  // documentation don't get validated. Order matters: fenced first (they
  // can contain backticks).
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');

  // Match `[text](url)` and `![alt](url)` — capture url up to the first
  // closing paren or whitespace (a markdown link can have a title attribute
  // like `[text](url "title")` which we strip by not consuming the space).
  const re = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const links: Link[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    links.push({ text: m[1], url: m[2] });
  }
  return links;
}

function isExternal(url: string): boolean {
  return /^(https?|mailto|tel|ftp):/i.test(url);
}

describe('README.md links', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const readmeHeadings = extractHeadingSlugs(readme);
  const links = extractLinks(readme);

  // Sanity: parser actually found something. Catches the case where someone
  // accidentally breaks the regex and the suite passes vacuously with zero
  // links checked.
  it('parser found at least 10 links to validate', () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it('all internal anchor links (#slug) resolve to a heading in README', () => {
    const broken: string[] = [];
    for (const { text, url } of links) {
      if (!url.startsWith('#')) continue;
      const slug = url.slice(1);
      if (!readmeHeadings.has(slug)) {
        broken.push(`[${text}](${url}) — no heading with slug "${slug}" in README`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('all relative-path links point to files that exist on disk', () => {
    const broken: string[] = [];
    for (const { text, url } of links) {
      if (isExternal(url) || url.startsWith('#')) continue;
      const [path] = url.split('#');     // strip optional anchor
      if (!path) continue;               // pure-anchor links handled above
      const filePath = join(REPO_ROOT, path);
      if (!existsSync(filePath)) {
        broken.push(`[${text}](${url}) — file ${path} does not exist`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('all anchored relative-path links (file.md#section) resolve to a heading in the target file', () => {
    const broken: string[] = [];
    for (const { text, url } of links) {
      if (isExternal(url) || url.startsWith('#')) continue;
      const [path, anchor] = url.split('#');
      if (!path || !anchor) continue;    // need both to validate
      const filePath = join(REPO_ROOT, path);
      if (!existsSync(filePath)) continue;   // already reported by previous test
      // Only validate if it's a markdown file — non-md files don't have
      // markdown anchors (e.g. an HTML anchor inside a .html doesn't follow
      // the same slug rule).
      if (!path.endsWith('.md')) continue;
      const target = readFileSync(filePath, 'utf8');
      const targetHeadings = extractHeadingSlugs(target);
      if (!targetHeadings.has(anchor)) {
        broken.push(`[${text}](${url}) — heading "#${anchor}" not found in ${path}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
