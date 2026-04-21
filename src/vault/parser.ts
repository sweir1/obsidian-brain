import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge } from '../types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

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
): ParsedFile {
  let fm: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(raw);
    fm = parsed.data;
    content = parsed.content;
  } catch {
    console.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`);
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
    const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
    const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

    if (!targetId) {
      stubIds.add(resolvedTarget);
    }

    const paragraph =
      paragraphs.find((p) => p.includes(`[[${link.raw}`)) ??
      paragraphs.find((p) => p.includes(link.display ?? link.raw)) ??
      '';

    // Clean the stored edge `context` so it doesn't leak wiki-link syntax
    // for the edge's own target:
    //   1. Drop a trailing `[[Target]]` entirely — that's what `link_notes`
    //      appends, and it's redundant since the target is already captured
    //      by `targetId`. Matches the tester's "see related note" → stored
    //      as "see related note" expectation.
    //   2. For any remaining inline `[[Target]]` (or `[[Target|display]]`),
    //      keep the semantic text — replace with the display alias or the
    //      raw link text. Preserves readability in body-prose contexts.
    const esc = escapeRegExp(link.raw);
    const trailingPattern = new RegExp(
      `\\s*!?\\[\\[${esc}(?:\\|[^\\]]+)?\\]\\]\\s*$`,
    );
    const inlinePattern = new RegExp(
      `!?\\[\\[${esc}(?:\\|([^\\]]+))?\\]\\]`,
      'g',
    );
    const context = paragraph
      .replace(trailingPattern, '')
      .replace(inlinePattern, (_m: string, display?: string) => display ?? link.raw)
      .replace(/[ \t]+/g, ' ')
      .trim();

    edges.push({
      sourceId: relPath,
      targetId: resolvedTarget,
      context,
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

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');
    const parsed = parseFileFromContent(relPath, raw, stemLookup, allPathsSet);
    nodes.push(parsed.node);
    edges.push(...parsed.edges);
    for (const stub of parsed.stubIds) stubIds.add(stub);
  }

  return { nodes, edges, stubIds };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const pattern = /(?<!\w)#([a-zA-Z][\w-\/]*)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tags.add(match[1]);
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

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
