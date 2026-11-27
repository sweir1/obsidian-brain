import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
  isAttachmentLink,
  stripCode,
  type RawLink,
} from './wiki-links.js';
import { logger } from '../util/logger.js';
import type { ParsedNode, ParsedEdge } from '../types.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/vault/parser.ts');

import { EXCLUDED_DIRS, getVaultIgnore, type VaultIgnore } from './ignore.js';

export { EXCLUDED_DIRS };

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

export interface ParsedFile {
  node: ParsedNode;
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

/**
 * Parse a single file's raw contents into a node + outbound edges + any stub
 * targets the edges point at. Pure — no I/O. Shared by parseVault (for the
 * whole-vault loop) and the watcher's single-file reindex path.
 */
export function parseFileFromContent(
  relPath: string,
  raw: string,
  stemLookup: Map<string, string[]>,
  allPathsSet: Set<string>,
  warnedAmbiguous?: Set<string>,
): ParsedFile {
  let fm: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(raw);
    fm = parsed.data;
    content = parsed.content;
  } catch {
    logger.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`, {
      path: relPath,
    });
    fm = {};
    content = raw;
  }

  const title = (fm.title as string) ?? basename(relPath, '.md');

  const inlineTags = extractInlineTags(content);
  const inlineFields = extractInlineFields(content);
  // YAML frontmatter wins over inline `key:: value` — explicit structured
  // metadata takes precedence over body-level convenience fields.
  const frontmatter: Record<string, unknown> = { ...inlineFields, ...fm };
  if (inlineTags.length > 0) {
    frontmatter.inline_tags = inlineTags;
  }

  const node: ParsedNode = { id: relPath, title, content, frontmatter };

  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();
  const links = extractWikiLinks(content);
  const paragraphs = content.split(/\n\n+/);

  for (const link of links) {
    // Split heading (#) / block-reference (^) suffix from the raw link so
    // only the bare stem is used for resolution + stub id. The fragment
    // rides alongside on the edge row (schema v4 addition). Without this
    // split, `[[BMW#Specs]]` would create `_stub/BMW#Specs.md` and never
    // migrate when `BMW.md` appears, since `resolveForwardStubs` skips
    // anything with `#` / `^` in the stub id.
    const hashIdx = link.raw.search(/[#^]/);
    const bareRaw = hashIdx === -1 ? link.raw : link.raw.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? null : link.raw.slice(hashIdx + 1);

    // Same-note heading / block links (`[[#Section]]`, `[[^block]]`,
    // `![[#Section]]`) point inside this note. They are navigation, not a
    // relationship between notes: no edge, and above all no `_stub/.md`.
    if (bareRaw.trim() === '') continue;

    const targetId = resolveLink(bareRaw, stemLookup, allPathsSet, relPath, warnedAmbiguous);
    // Attachments (`![[diagram.png]]`, `[[spec.pdf]]`) aren't notes: no
    // edge and no fake `_stub/diagram.png.md`. Checked after resolution so
    // a real note that happens to be named `x.png.md` still links.
    if (!targetId && isAttachmentLink(bareRaw)) continue;
    const resolvedTarget = targetId ?? `_stub/${bareRaw}.md`;

    if (!targetId) {
      stubIds.add(resolvedTarget);
    }

    const paragraph =
      paragraphs.find((p) => p.includes(`[[${link.raw}`)) ??
      paragraphs.find((p) => p.includes(link.display ?? link.raw)) ??
      '';

    const context = buildEdgeContext(paragraph, link);

    edges.push({
      sourceId: relPath,
      targetId: resolvedTarget,
      context,
      targetSubpath: fragment,
    });
  }

  return { node, edges, stubIds };
}

/**
 * Read and parse a single file on disk. Thin wrapper over parseFileFromContent
 * that handles file I/O and builds the stemLookup from a caller-supplied
 * path list (typically the sync table).
 */
export async function parseSingleFile(
  vaultPath: string,
  relPath: string,
  allPaths: string[],
): Promise<ParsedFile> {
  const raw = await readFile(join(vaultPath, relPath), 'utf-8');
  const stemLookup = buildStemLookup(allPaths);
  const allPathsSet = new Set(allPaths);
  return parseFileFromContent(relPath, raw, stemLookup, allPathsSet);
}

export async function parseVault(vaultPath: string): Promise<ParseResult> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  const stemLookup = buildStemLookup(mdPaths);
  const allPathsSet = new Set(mdPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();
  // V1: per-parseVault dedup for ambiguous-link warnings. One reindex pass
  // emits at most one stderr line per distinct ambiguous stem (vs. one per
  // occurrence) — drops 1224 lines to 8 on the canonical 10k-vault.
  const warnedAmbiguous = new Set<string>();

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');
    const parsed = parseFileFromContent(relPath, raw, stemLookup, allPathsSet, warnedAmbiguous);
    nodes.push(parsed.node);
    edges.push(...parsed.edges);
    for (const stub of parsed.stubIds) stubIds.add(stub);
  }

  return { nodes, edges, stubIds };
}

/**
 * Characters of surrounding text kept on each side of the link occurrence.
 * ~300 chars of total context is plenty to explain a link; storing the
 * whole paragraph made hub notes (long link lists with no blank lines =
 * one giant "paragraph") write 13-55 KB per edge.
 */
const EDGE_CONTEXT_RADIUS = 150;
/** How far a window edge may move to land on a word boundary. */
const EDGE_CONTEXT_WORD_SLACK = 30;
/**
 * Absolute ceiling on a stored context. Only reachable with a pathological
 * link (e.g. a multi-KB alias), since the window is otherwise
 * 2 × radius + the link itself.
 */
const EDGE_CONTEXT_MAX_CHARS = 1000;
const ELLIPSIS = '…';

/**
 * Build the stored edge `context`: a bounded window of the paragraph around
 * the link occurrence, cleaned so it doesn't leak wiki-link syntax for the
 * edge's own target:
 *   1. Drop a trailing `[[Target]]` entirely — that's what `link_notes`
 *      appends, and it's redundant since the target is already captured by
 *      `targetId` ("see related note [[X]]" is stored as "see related note").
 *   2. For any remaining inline `[[Target]]` (or `[[Target|display]]`), keep
 *      the semantic text — replace with the display alias or the raw link
 *      text. Preserves readability in body-prose contexts.
 * When the window doesn't reach a paragraph edge, an ellipsis marks the cut.
 * Short paragraphs fit entirely inside the window and are stored whole.
 */
export function buildEdgeContext(paragraph: string, link: RawLink): string {
  const esc = escapeRegExp(link.raw);
  const trailingPattern = new RegExp(
    `\\s*!?\\[\\[${esc}(?:\\|[^\\]]+)?\\]\\]\\s*$`,
  );
  const inlineSource = `!?\\[\\[${esc}(?:\\|([^\\]]+))?\\]\\]`;

  // Locate the link occurrence: exact `[[raw]]` / `[[raw|alias]]` first,
  // then the looser matches the paragraph lookup itself used.
  let linkStart = -1;
  let linkEnd = -1;
  const exact = new RegExp(inlineSource).exec(paragraph);
  if (exact) {
    linkStart = exact.index;
    linkEnd = exact.index + exact[0].length;
  } else {
    const needle = paragraph.includes(`[[${link.raw}`) ? `[[${link.raw}` : (link.display ?? link.raw);
    linkStart = paragraph.indexOf(needle);
    linkEnd = linkStart + needle.length;
  }
  if (linkStart === -1) {
    linkStart = 0;
    linkEnd = 0;
  }

  let start = Math.max(0, linkStart - EDGE_CONTEXT_RADIUS);
  let end = Math.min(paragraph.length, linkEnd + EDGE_CONTEXT_RADIUS);

  // Never cut through another `[[…]]` — a half link would survive cleanup
  // as raw bracket noise. Links don't nest, so moving start forward past a
  // straddling link (or end back before one) never crosses the target link.
  if (start > 0) {
    const open = paragraph.lastIndexOf('[[', start - 1);
    const close = open === -1 ? -1 : paragraph.indexOf(']]', open);
    if (close !== -1 && close + 2 > start && close + 2 <= linkStart) start = close + 2;
  }
  if (end < paragraph.length) {
    const open = paragraph.lastIndexOf('[[', end - 1);
    const close = open === -1 ? -1 : paragraph.indexOf(']]', open);
    if (open >= linkEnd && close !== -1 && close + 2 > end) end = open;
  }

  // Prefer word boundaries, within a small slack (CJK text without spaces
  // just keeps the raw cut).
  if (start > 0 && !/\s/.test(paragraph[start - 1]!)) {
    const limit = Math.min(start + EDGE_CONTEXT_WORD_SLACK, linkStart);
    for (let i = start; i < limit; i++) {
      if (/\s/.test(paragraph[i]!)) {
        start = i + 1;
        break;
      }
    }
  }
  if (end < paragraph.length && !/\s/.test(paragraph[end]!)) {
    const limit = Math.max(end - EDGE_CONTEXT_WORD_SLACK, linkEnd);
    for (let i = end - 1; i >= limit; i--) {
      if (/\s/.test(paragraph[i]!)) {
        end = i;
        break;
      }
    }
  }

  let window = paragraph.slice(start, end);
  // The trailing-link rule only applies at the real end of the paragraph;
  // a link that merely sits at the window's edge is mid-prose.
  if (end === paragraph.length) window = window.replace(trailingPattern, '');
  let context = window
    .replace(new RegExp(inlineSource, 'g'), (_m: string, display?: string) => display ?? link.raw)
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (context.length > EDGE_CONTEXT_MAX_CHARS) {
    context = context.slice(0, EDGE_CONTEXT_MAX_CHARS).trimEnd();
    end = -1; // force the trailing ellipsis below
  }
  if (context.length === 0) return context;
  if (start > 0) context = ELLIPSIS + context;
  if (end !== paragraph.length) context = context + ELLIPSIS;
  return context;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regions where a `#word` is never a tag in Obsidian. Each is blanked to a
 * space before tag matching. Code is removed first (via `stripCode`) so a
 * `%%` or `[[` inside code can't open a bogus region.
 */
const NON_TAG_REGIONS: readonly RegExp[] = [
  /<!--[\s\S]*?-->/g,               // HTML comments
  /%%[\s\S]*?%%/g,                  // Obsidian comments
  /!?\[\[[^\]\n]*\]\]/g,              // wiki links + embeds: [[#Section]], [[Note#Heading]]
  /\]\([^)\n]*\)/g,                  // markdown link / image targets: [x](page#frag)
  /<[a-z][a-z0-9+.-]*:[^>\s]*>/gi,   // autolinks: <https://x.com/#a>
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,   // bare URLs: https://x.com/#anchor
];

function extractInlineTags(content: string): string[] {
  let text = stripCode(content);
  for (const re of NON_TAG_REGIONS) text = text.replace(re, ' ');
  const tags = new Set<string>();
  // Obsidian tag body: Unicode letters (plus combining marks, so Indic /
  // Thai scripts survive), digits, `_`, `-`, `/`. A `#` glued to a
  // preceding letter/digit/underscore (`foo#bar`) is not a tag, and `&` is
  // excluded so HTML entities (`&#x27;`) aren't read as tags.
  const pattern = /(?<![\p{L}\p{M}\p{N}_&])#([\p{L}\p{M}\p{N}_\-/]+)/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const tag = match[1]!;
    // Must contain at least one non-numeric character: `#2024` isn't a tag,
    // `#y2024` and `#2024-review` are.
    if (/^\p{N}+$/u.test(tag)) continue;
    tags.add(tag);
  }
  return [...tags];
}

/**
 * Parse Dataview-style inline fields: `key:: value` at the start of a line.
 * Covers the common metadata case (status, priority, etc.) without needing
 * Obsidian or the Dataview plugin running. Values land flat on the node's
 * frontmatter so existing filters (rank_notes `where`, search) see them.
 *
 * Does NOT handle inline `[key:: value]` bracket syntax or Dataview's full
 * task-metadata DSL — those require an actual DQL engine.
 */
function extractInlineFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '');
  const pattern = /^([A-Za-z_][\w-]*)::[ \t]*(.+?)[ \t]*$/gm;
  let match;
  while ((match = pattern.exec(withoutCode)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined && !(key in fields)) {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Every markdown file the index should hold, as vault-relative `/` paths.
 * Skips the built-in exclusions and the user's (`.obsidianbrainignore`,
 * `OBSIDIAN_BRAIN_IGNORE`, optionally Obsidian's Excluded files); an
 * excluded folder is never descended into.
 */
export async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
  ig: VaultIgnore = getVaultIgnore(vaultPath),
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ig.isUserExcluded(relPath, true)) continue;
      results.push(...await collectMarkdownFiles(vaultPath, relPath, ig));
    } else if (entry.name.endsWith('.md')) {
      if (ig.isUserExcluded(relPath, false)) continue;
      results.push(relPath);
    }
  }

  return results;
}
