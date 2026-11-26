import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import type { DatabaseHandle } from '../store/db.js';
import type { NextAction, ToolContext } from './hints.js';
import { describeEmbedderPreparing } from './preparing.js';
import { EXCLUDED_DIRS } from '../vault/parser.js';
import { extractWikiLinks, isAttachmentLink } from '../vault/wiki-links.js';

/**
 * `vault_health` — read-only vault hygiene report computed from the SQLite
 * index plus cheap filesystem stats. Nothing is re-parsed: wiki-link
 * resolution already happened at index time (unresolved targets live as
 * `_stub/<name>.md` nodes with `frontmatter._stub: true`), so every graph
 * check is a SQL query. Only `index_drift` touches the disk, and only via
 * `readdir` + `stat`.
 */

export const HEALTH_CHECKS = [
  'broken_links',
  'broken_anchors',
  'orphans',
  'missing_frontmatter',
  'empty_notes',
  'duplicate_names',
  'index_drift',
] as const;

export type HealthCheck = (typeof HEALTH_CHECKS)[number];
export type Severity = 'error' | 'warn' | 'info';

export const DEFAULT_FINDINGS_LIMIT = 50;
/**
 * A note whose body (frontmatter excluded, whitespace trimmed) is shorter than
 * this many characters is reported by `empty_notes`. 50 chars is roughly one
 * short sentence — enough to exclude a lone heading, a single wiki-link or a
 * "TODO" placeholder, while letting genuinely terse notes through.
 */
export const DEFAULT_MIN_BODY_CHARS = 50;

/** SQL predicate: the row in `nodes` aliased as `alias` is NOT a stub. */
const notStub = (alias: string): string =>
  `COALESCE(json_extract(${alias}.frontmatter, '$._stub'), 0) != 1`;

export interface BrokenLinkFinding {
  severity: Severity;
  source: string;
  /** Link text as written (minus `#heading` / `^block` suffix and `|alias`). */
  target: string;
  /** `note` = no note matches; `attachment` = a linked / embedded file isn't on disk. */
  kind: 'note' | 'attachment';
  /** Number of `[[target]]` occurrences in `source`. */
  occurrences: number;
}

export type AnchorKind = 'heading' | 'block';

export interface BrokenAnchorFinding {
  severity: Severity;
  source: string;
  /** Path of the note the link points into (equals `source` for `[[#Section]]`). */
  target: string;
  /** The fragment as written: `Heading`, `Parent#Child`, or `^blockid`. */
  anchor: string;
  kind: AnchorKind;
  /** Number of links from `source` with this exact target + anchor. */
  occurrences: number;
}

export interface NoteFinding {
  severity: Severity;
  path: string;
  title: string;
}

export interface EmptyNoteFinding extends NoteFinding {
  bodyChars: number;
}

export interface DuplicateNameFinding {
  severity: Severity;
  name: string;
  paths: string[];
}

export type DriftKind = 'modified_since_index' | 'not_indexed' | 'missing_on_disk';

export interface DriftFinding {
  severity: Severity;
  path: string;
  kind: DriftKind;
  /** Disk mtime (epoch ms). Absent for `missing_on_disk`. */
  diskMtime?: number;
  /** mtime recorded at the last index pass (epoch ms), when known. */
  indexedMtime?: number;
}

export interface CheckResult<T> {
  /** Total findings for this check (before `limit` truncation). */
  count: number;
  truncated: boolean;
  items: T[];
}

export interface VaultHealthFindings {
  broken_links?: CheckResult<BrokenLinkFinding>;
  broken_anchors?: CheckResult<BrokenAnchorFinding>;
  orphans?: CheckResult<NoteFinding>;
  missing_frontmatter?: CheckResult<NoteFinding>;
  empty_notes?: CheckResult<EmptyNoteFinding>;
  duplicate_names?: CheckResult<DuplicateNameFinding>;
  index_drift?: CheckResult<DriftFinding>;
}

export interface VaultHealthReport {
  summary: string;
  scope: string | null;
  checksRun: HealthCheck[];
  notesScanned: number;
  counts: Partial<Record<HealthCheck, number>>;
  bySeverity: Record<Severity, number>;
  findings: VaultHealthFindings;
  /** Present only when the index may be incomplete (reindex in flight, embedder still loading). */
  indexWarning?: string;
}

export interface VaultHealthOptions {
  checks?: readonly HealthCheck[];
  scope?: string;
  limit?: number;
  minBodyChars?: number;
}

/** Strip `./`, leading and trailing slashes. Empty string → no scope. */
export function normaliseScope(scope: string | undefined): string | null {
  if (scope === undefined) return null;
  const s = scope.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
  return s === '' || s === '.' ? null : s;
}

function inScope(path: string, scope: string | null): boolean {
  return scope === null || path === scope || path.startsWith(scope + '/');
}

function finish<T>(items: T[], limit: number): CheckResult<T> {
  return { count: items.length, truncated: items.length > limit, items: items.slice(0, limit) };
}

const stemOf = (id: string): string => id.replace(/\.md$/, '').split('/').pop()!;

/** `_stub/Folder/Name.md` → `Folder/Name`; any other dangling id → itself minus `.md`. */
function stubDisplayName(targetId: string): string {
  return targetId.replace(/^_stub\//, '').replace(/\.md$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the indexed frontmatter carries at least one key that came from
 * YAML. The parser merges Dataview inline fields (`key:: value` lines) and
 * `inline_tags` into the same object, so those are discounted: a key counts as
 * inline-derived when the body has a matching `key::` line.
 */
export function hasYamlFrontmatter(frontmatter: Record<string, unknown>, body: string): boolean {
  for (const key of Object.keys(frontmatter)) {
    if (key === 'inline_tags') continue;
    const inline = new RegExp(`^${escapeRegExp(key)}::`, 'm');
    if (!inline.test(body)) return true;
  }
  return false;
}

interface RealNoteRow {
  id: string;
  title: string;
  content: string | null;
  frontmatter: string;
}

/** A wiki-link split the way the parser splits it: target before the first `#` / `^`. */
interface SplitLink {
  target: string;
  /** Text after the separator (separator dropped), or null. */
  fragment: string | null;
  separator: '#' | '^' | null;
}

function splitLink(raw: string): SplitLink {
  const i = raw.search(/[#^]/);
  if (i === -1) return { target: raw.trim(), fragment: null, separator: null };
  return {
    target: raw.slice(0, i).trim(),
    fragment: raw.slice(i + 1),
    separator: raw[i] as '#' | '^',
  };
}

function checkBrokenNoteLinks(db: DatabaseHandle, scope: string | null): BrokenLinkFinding[] {
  // Unresolved note links point at a `_stub/...` node (materialised at index
  // time) or, rarely, at an id with no node row at all (read_note treats both
  // as unresolved). Group per (source, target) so a link repeated five times
  // in one note is one finding with `occurrences: 5`.
  const rows = db
    .prepare(
      `SELECT e.source_id AS source, e.target_id AS target, COUNT(*) AS occurrences
         FROM edges e
         LEFT JOIN nodes t ON t.id = e.target_id
        WHERE t.id IS NULL OR json_extract(t.frontmatter, '$._stub') = 1
        GROUP BY e.source_id, e.target_id
        ORDER BY e.source_id, e.target_id`,
    )
    .all() as Array<{ source: string; target: string; occurrences: number }>;
  return rows
    .map((r) => ({
      severity: 'warn' as const,
      source: r.source,
      target: stubDisplayName(r.target),
      kind: 'note' as const,
      occurrences: r.occurrences,
    }))
    // The parser no longer emits edges for same-note links (`[[#Section]]`)
    // or attachments, but an index built before that still carries
    // `_stub/.md` / `_stub/diagram.png.md` edges until the source note is
    // next re-indexed. Skip them: same-note anchors are `broken_anchors`'
    // job and attachments are checked on disk below.
    .filter((r) => r.target !== '' && !isAttachmentLink(r.target) && inScope(r.source, scope));
}

/** Every non-markdown file in the vault, for resolving attachment links. */
interface AttachmentIndex {
  /** Lower-cased vault-relative paths. */
  paths: Set<string>;
  /** Lower-cased basenames. */
  names: Set<string>;
}

/**
 * Walk the whole vault for non-`.md` files. Same skip rules as the note walk
 * (dot-entries, the parser's `EXCLUDED_DIRS`) EXCEPT `attachments/`: the
 * indexer skips it for notes, but it's exactly where Obsidian puts pasted
 * files, so attachment links must be able to resolve into it.
 */
async function walkAttachments(vaultPath: string): Promise<AttachmentIndex> {
  const paths = new Set<string>();
  const names = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(vaultPath, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'attachments' && EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(relPath);
      } else if (!entry.name.toLowerCase().endsWith('.md')) {
        paths.add(relPath.toLowerCase());
        names.add(entry.name.toLowerCase());
      }
    }
  };
  await walk('');
  return { paths, names };
}

/** Collapse `.` / `..` segments; null if the path climbs out of the vault. */
function normaliseRelPath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/**
 * Obsidian's attachment resolution: the link as a vault-relative path (or,
 * for `./` / `../` links, relative to the linking note's folder), otherwise
 * any file with that basename anywhere in the vault — case-insensitive.
 */
function attachmentExists(target: string, sourcePath: string, files: AttachmentIndex): boolean {
  const t = target.replace(/\\/g, '/');
  const candidates: string[] = [];
  if (t.startsWith('./') || t.startsWith('../')) {
    const dir = sourcePath.split('/').slice(0, -1).join('/');
    const rel = normaliseRelPath(dir ? `${dir}/${t}` : t);
    if (rel !== null) candidates.push(rel);
  } else {
    const rel = normaliseRelPath(t);
    if (rel !== null) candidates.push(rel);
  }
  if (candidates.some((c) => files.paths.has(c.toLowerCase()))) return true;
  const name = t.split('/').pop()!.toLowerCase();
  return files.names.has(name);
}

async function checkBrokenAttachments(
  vaultPath: string,
  notes: RealNoteRow[],
  allNoteIds: Set<string>,
): Promise<BrokenLinkFinding[]> {
  // Attachment links create no edges, so scan the stored bodies. A link whose
  // target has an attachment extension but resolves to a note (`x.png.md`)
  // is a note link, exactly as the parser treats it.
  const noteStems = new Set([...allNoteIds].map((id) => stemOf(id).toLowerCase()));
  const pending: Array<{ source: string; target: string; occurrences: number }> = [];
  for (const n of notes) {
    const counts = new Map<string, number>();
    for (const link of extractWikiLinks(n.content ?? '')) {
      const { target } = splitLink(link.raw);
      if (target === '' || !isAttachmentLink(target)) continue;
      const lower = target.toLowerCase();
      if (allNoteIds.has(`${target}.md`) || noteStems.has(lower.split('/').pop()!)) continue;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    for (const [target, occurrences] of counts) pending.push({ source: n.id, target, occurrences });
  }
  if (pending.length === 0) return [];
  const files = await walkAttachments(vaultPath);
  return pending
    .filter((p) => !attachmentExists(p.target, p.source, files))
    .map((p) => ({ severity: 'warn' as const, source: p.source, target: p.target, kind: 'attachment' as const, occurrences: p.occurrences }));
}

/**
 * Normalise heading text the way Obsidian compares it when resolving
 * `[[Note#Heading]]`: case-insensitive, inline markup ignored (emphasis,
 * code, highlights, strikethrough, wiki/markdown link syntax), characters
 * Obsidian can't keep in a link subpath (`# | ^ : % [ ]`) treated as spaces,
 * and runs of whitespace collapsed.
 */
export function normaliseHeading(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|\*|_|`)/g, '')
    .replace(/[#|^:%[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface NoteAnchors {
  /** ATX headings in document order, normalised. */
  headings: Array<{ level: number; norm: string }>;
  /** Block ids (`^id` ending a line), lower-cased. */
  blocks: Set<string>;
}

/**
 * Extract headings + block ids from a note body. Fenced code blocks are
 * skipped so a `# comment` inside a bash snippet isn't treated as a heading.
 */
export function extractAnchors(content: string): NoteAnchors {
  const headings: NoteAnchors['headings'] = [];
  const blocks = new Set<string>();
  let fence: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) headings.push({ level: h[1]!.length, norm: normaliseHeading(h[2]!) });
    const b = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/.exec(line);
    if (b) blocks.add(b[1]!.toLowerCase());
  }
  return { headings, blocks };
}

/**
 * Does `[[...#A#B#C]]` resolve? The last segment must match a heading, and
 * the earlier segments must match that heading's ancestors in order (not
 * necessarily adjacent — Obsidian lets you skip levels).
 */
export function headingPathExists(anchors: NoteAnchors, segments: string[]): boolean {
  const want = segments.map(normaliseHeading).filter((s) => s !== '');
  if (want.length === 0) return true;
  const last = want[want.length - 1]!;
  const parents = want.slice(0, -1);
  const stack: Array<{ level: number; norm: string }> = [];
  for (const h of anchors.headings) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    if (h.norm === last) {
      let i = 0;
      for (const anc of stack) if (i < parents.length && anc.norm === parents[i]) i++;
      if (i === parents.length) return true;
    }
    stack.push(h);
  }
  return false;
}

function checkBrokenAnchors(
  db: DatabaseHandle,
  scope: string | null,
  scopedNotes: RealNoteRow[],
): BrokenAnchorFinding[] {
  const getContent = db.prepare('SELECT content FROM nodes WHERE id = ?');
  const contentCache = new Map<string, string>();
  const contentOf = (id: string): string => {
    let c = contentCache.get(id);
    if (c === undefined) {
      c = ((getContent.get(id) as { content: string | null } | undefined)?.content) ?? '';
      contentCache.set(id, c);
    }
    return c;
  };
  for (const n of scopedNotes) contentCache.set(n.id, n.content ?? '');
  const anchorCache = new Map<string, NoteAnchors>();
  const anchorsOf = (id: string): NoteAnchors => {
    let a = anchorCache.get(id);
    if (!a) {
      a = extractAnchors(contentOf(id));
      anchorCache.set(id, a);
    }
    return a;
  };
  const resolves = (target: string, kind: AnchorKind, anchor: string): boolean =>
    kind === 'block'
      ? anchorsOf(target).blocks.has(anchor.slice(1).toLowerCase())
      : headingPathExists(anchorsOf(target), anchor.split('#'));

  const out: BrokenAnchorFinding[] = [];

  // 1. Links into another note (or into this one by name, `[[OwnName#S]]`).
  //    The parser splits at the first `#` / `^` and stores the remainder,
  //    separator dropped, in `edges.target_subpath`. Only real-note targets
  //    are checked; a missing note is `broken_links`' job.
  const rows = db
    .prepare(
      `SELECT e.source_id AS source, e.target_id AS target, e.target_subpath AS subpath, COUNT(*) AS occurrences
         FROM edges e
         JOIN nodes t ON t.id = e.target_id
        WHERE e.target_subpath IS NOT NULL AND e.target_subpath != '' AND ${notStub('t')}
        GROUP BY e.source_id, e.target_id, e.target_subpath
        ORDER BY e.source_id, e.target_id, e.target_subpath`,
    )
    .all() as Array<{ source: string; target: string; subpath: string; occurrences: number }>;
  for (const r of rows) {
    if (!inScope(r.source, scope)) continue;
    // `[[Note#^id]]` keeps its `^`; the bare `[[Note^id]]` form loses it, so
    // fall back to looking for `^<subpath>` inside a link in the source text.
    let kind: AnchorKind = 'heading';
    let anchor = r.subpath;
    if (anchor.startsWith('^')) {
      kind = 'block';
    } else if (
      new RegExp(`\\[\\[[^\\]|]*\\^${escapeRegExp(anchor)}(?:\\||\\]\\])`).test(contentOf(r.source))
    ) {
      kind = 'block';
      anchor = `^${anchor}`;
    }
    if (resolves(r.target, kind, anchor)) continue;
    out.push({ severity: 'warn', source: r.source, target: r.target, anchor, kind, occurrences: r.occurrences });
  }

  // 2. Same-note links (`[[#Section]]`, `[[^id]]`, `![[#Section]]`) produce
  //    no edge, so find them in each in-scope note's stored body.
  for (const n of scopedNotes) {
    const counts = new Map<string, { kind: AnchorKind; n: number }>();
    for (const link of extractWikiLinks(n.content ?? '')) {
      const { target, fragment, separator } = splitLink(link.raw);
      if (target !== '' || fragment === null || fragment.trim() === '') continue;
      const kind: AnchorKind = separator === '^' || fragment.startsWith('^') ? 'block' : 'heading';
      const anchor = kind === 'block' && !fragment.startsWith('^') ? `^${fragment}` : fragment;
      const entry = counts.get(anchor);
      if (entry) entry.n++;
      else counts.set(anchor, { kind, n: 1 });
    }
    for (const [anchor, { kind, n: occurrences }] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (resolves(n.id, kind, anchor)) continue;
      out.push({ severity: 'warn', source: n.id, target: n.id, anchor, kind, occurrences });
    }
  }
  return out.sort(
    (a, b) =>
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
      (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0),
  );
}

function checkOrphans(db: DatabaseHandle, scope: string | null): NoteFinding[] {
  // Orphan = a real note with no link to or from another real note. Links to
  // stubs (broken links) and self-links don't count — a note whose only link
  // is broken is still disconnected from the rest of the vault.
  const rows = db
    .prepare(
      `SELECT n.id AS path, n.title AS title
         FROM nodes n
        WHERE ${notStub('n')}
          AND NOT EXISTS (
            SELECT 1 FROM edges e JOIN nodes t ON t.id = e.target_id
             WHERE e.source_id = n.id AND e.target_id != n.id AND ${notStub('t')})
          AND NOT EXISTS (
            SELECT 1 FROM edges e JOIN nodes s ON s.id = e.source_id
             WHERE e.target_id = n.id AND e.source_id != n.id AND ${notStub('s')})
        ORDER BY n.id`,
    )
    .all() as Array<{ path: string; title: string }>;
  return rows
    .filter((r) => inScope(r.path, scope))
    .map((r) => ({ severity: 'info' as const, path: r.path, title: r.title }));
}

function checkContent(
  notes: RealNoteRow[],
  wantFrontmatter: boolean,
  wantEmpty: boolean,
  minBodyChars: number,
): { missing: NoteFinding[]; empty: EmptyNoteFinding[] } {
  const missing: NoteFinding[] = [];
  const empty: EmptyNoteFinding[] = [];
  for (const n of notes) {
    const body = n.content ?? '';
    if (wantFrontmatter) {
      const fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
      if (!hasYamlFrontmatter(fm, body)) {
        missing.push({ severity: 'info', path: n.id, title: n.title });
      }
    }
    if (wantEmpty) {
      const bodyChars = body.trim().length;
      if (bodyChars < minBodyChars) {
        empty.push({ severity: 'warn', path: n.id, title: n.title, bodyChars });
      }
    }
  }
  return { missing, empty };
}

function checkDuplicateNames(notes: RealNoteRow[], scope: string | null): DuplicateNameFinding[] {
  // Obsidian resolves `[[name]]` case-insensitively, so `Notes.md` and
  // `notes.md` in different folders compete for the same bare link. Group by
  // basename (minus `.md`), Unicode-NFC-normalised and lower-cased; report
  // the exact paths. `name` is the basename of the first path in sort order.
  const byStem = new Map<string, string[]>();
  for (const n of notes) {
    const key = stemOf(n.id).normalize('NFC').toLowerCase();
    const list = byStem.get(key);
    if (list) list.push(n.id);
    else byStem.set(key, [n.id]);
  }
  const out: DuplicateNameFinding[] = [];
  for (const group of byStem.values()) {
    if (group.length < 2) continue;
    // The ambiguity is vault-wide, so a group is in scope when any member is,
    // and every member is listed.
    if (!group.some((p) => inScope(p, scope))) continue;
    const paths = [...group].sort();
    out.push({ severity: 'warn', name: stemOf(paths[0]!), paths });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Same skip rule as the indexer's vault walk (`collectMarkdownFiles` in
 * src/vault/parser.ts): every dot-prefixed entry, plus directories named in
 * the parser's `EXCLUDED_DIRS`.
 */
function isExcludedSegment(segment: string, isDir: boolean): boolean {
  return segment.startsWith('.') || (isDir && EXCLUDED_DIRS.has(segment));
}

/** Markdown files the indexer would pick up, as vault-relative paths → mtimeMs. */
async function walkVault(vaultPath: string, subdir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(vaultPath, rel), { withFileTypes: true });
    } catch (err) {
      // A scope that doesn't exist on disk (or a dir removed mid-walk) is an
      // empty subtree, not a failure.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (isExcludedSegment(entry.name, entry.isDirectory())) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          out.set(relPath, (await stat(join(vaultPath, relPath))).mtimeMs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
  };
  await walk(subdir);
  return out;
}

async function checkIndexDrift(
  db: DatabaseHandle,
  vaultPath: string,
  notes: RealNoteRow[],
  scope: string | null,
): Promise<DriftFinding[]> {
  // A scope that passes through an excluded dir (`attachments/...`,
  // `.obsidian/...`) is never indexed, so there's nothing to drift.
  const scopeExcluded =
    scope !== null && scope.split('/').some((seg) => isExcludedSegment(seg, true));
  const onDisk = scopeExcluded ? new Map<string, number>() : await walkVault(vaultPath, scope ?? '');

  const syncRows = db.prepare('SELECT path, mtime FROM sync').all() as Array<{
    path: string;
    mtime: number;
  }>;
  const syncMtime = new Map(syncRows.map((r) => [r.path, r.mtime]));
  const indexed = new Set(notes.map((n) => n.id));

  const out: DriftFinding[] = [];
  for (const [path, diskMtime] of onDisk) {
    if (!indexed.has(path)) {
      out.push({ severity: 'warn', path, kind: 'not_indexed', diskMtime });
      continue;
    }
    // Same comparison the indexer uses to decide whether to re-index
    // (`prevMtime >= mtime` → skip). A note with no sync row is queued for
    // an embedding retry, not drifted — `index_status` reports those.
    const prev = syncMtime.get(path);
    if (prev !== undefined && diskMtime > prev) {
      out.push({
        severity: 'warn',
        path,
        kind: 'modified_since_index',
        diskMtime,
        indexedMtime: prev,
      });
    }
  }
  for (const n of notes) {
    if (onDisk.has(n.id)) continue;
    const prev = syncMtime.get(n.id);
    out.push({
      severity: 'error',
      path: n.id,
      kind: 'missing_on_disk',
      ...(prev !== undefined ? { indexedMtime: prev } : {}),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

/**
 * Run the requested checks. Pure over (db, filesystem) — no ServerContext —
 * so tests can drive it against a fixture DB + temp vault directly.
 */
export async function computeVaultHealth(
  db: DatabaseHandle,
  vaultPath: string,
  opts: VaultHealthOptions = {},
): Promise<VaultHealthReport> {
  const checks: HealthCheck[] =
    opts.checks && opts.checks.length > 0
      ? HEALTH_CHECKS.filter((c) => opts.checks!.includes(c))
      : [...HEALTH_CHECKS];
  const want = new Set(checks);
  const scope = normaliseScope(opts.scope);
  const limit = opts.limit ?? DEFAULT_FINDINGS_LIMIT;
  const minBodyChars = opts.minBodyChars ?? DEFAULT_MIN_BODY_CHARS;

  const allNotes = db
    .prepare(`SELECT n.id, n.title, n.content, n.frontmatter FROM nodes n WHERE ${notStub('n')} ORDER BY n.id`)
    .all() as RealNoteRow[];
  const scopedNotes = allNotes.filter((n) => inScope(n.id, scope));

  // Full (untruncated) finding lists per check. Counts and severity totals are
  // computed over these, so the summary stays honest when `limit` truncates.
  const full: { [K in HealthCheck]?: Array<{ severity: Severity }> } = {};
  if (want.has('broken_links')) {
    const notes = checkBrokenNoteLinks(db, scope);
    const attachments = await checkBrokenAttachments(
      vaultPath,
      scopedNotes,
      new Set(allNotes.map((n) => n.id)),
    );
    full.broken_links = [...notes, ...attachments].sort(
      (a, b) =>
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
        (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    );
  }
  if (want.has('broken_anchors')) full.broken_anchors = checkBrokenAnchors(db, scope, scopedNotes);
  if (want.has('orphans')) full.orphans = checkOrphans(db, scope);
  if (want.has('missing_frontmatter') || want.has('empty_notes')) {
    const { missing, empty } = checkContent(
      scopedNotes,
      want.has('missing_frontmatter'),
      want.has('empty_notes'),
      minBodyChars,
    );
    if (want.has('missing_frontmatter')) full.missing_frontmatter = missing;
    if (want.has('empty_notes')) full.empty_notes = empty;
  }
  if (want.has('duplicate_names')) full.duplicate_names = checkDuplicateNames(allNotes, scope);
  if (want.has('index_drift')) {
    full.index_drift = await checkIndexDrift(db, vaultPath, scopedNotes, scope);
  }

  const findings: Record<string, CheckResult<unknown>> = {};
  const counts: Partial<Record<HealthCheck, number>> = {};
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const check of checks) {
    const items = full[check]!;
    findings[check] = finish(items, limit);
    counts[check] = items.length;
    for (const item of items) bySeverity[item.severity]++;
  }

  const total = bySeverity.error + bySeverity.warn + bySeverity.info;
  const where = `${scopedNotes.length} note${scopedNotes.length === 1 ? '' : 's'}${scope ? ` in ${scope}/` : ''}`;
  const summary =
    total === 0
      ? `No issues found across ${where}.`
      : `${total} finding${total === 1 ? '' : 's'} across ${where} ` +
        `(${bySeverity.error} error, ${bySeverity.warn} warn, ${bySeverity.info} info): ` +
        checks.map((c) => `${counts[c]} ${c}`).join(', ') +
        '.';

  return {
    summary,
    scope,
    checksRun: checks,
    notesScanned: scopedNotes.length,
    counts,
    bySeverity,
    findings: findings as VaultHealthFindings,
  };
}

/**
 * Turn a report into `next_actions` pointing at the existing write / repair
 * tools. At most one suggestion per check, highest-value first.
 */
export function computeVaultHealthHints(report: VaultHealthReport): ToolContext {
  const next_actions: NextAction[] = [];
  const f = report.findings;

  const drift = f.index_drift;
  if (drift && drift.count > 0) {
    next_actions.push({
      description: 'Re-index the vault to pick up on-disk changes',
      tool: 'reindex',
      args: {},
      reason: `${drift.count} file${drift.count === 1 ? '' : 's'} differ between disk and index — every other check reads the index, so fix drift first`,
    });
  }

  // Missing attachments have no tool-shaped fix (no tool writes binary
  // files), so the hint only ever targets a missing note.
  const brokenNotes = (f.broken_links?.items ?? []).filter((b) => b.kind === 'note');
  if (brokenNotes.length > 0) {
    // Suggest the missing target linked from the most notes (within the
    // returned slice) — creating it fixes the most links in one call.
    const sources = new Map<string, number>();
    for (const b of brokenNotes) sources.set(b.target, (sources.get(b.target) ?? 0) + 1);
    const [target, n] = [...sources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    const slash = target.lastIndexOf('/');
    // `[[Name.md]]` is valid link syntax; create_note appends `.md` itself.
    const title = (slash === -1 ? target : target.slice(slash + 1)).replace(/\.md$/, '');
    const directory = slash === -1 ? undefined : target.slice(0, slash);
    next_actions.push({
      description: `Create missing note: ${target}`,
      tool: 'create_note',
      args: { title, content: '', ...(directory ? { directory } : {}) },
      reason: `${n} note${n === 1 ? '' : 's'} link${n === 1 ? 's' : ''} to [[${target}]] but no such note exists`,
    });
  }

  const anchors = f.broken_anchors;
  if (anchors && anchors.items.length > 0) {
    const first = anchors.items[0]!;
    next_actions.push({
      description: `Check the ${first.kind}s in ${first.target}`,
      tool: 'read_note',
      args: { name: first.target, mode: 'full' },
      reason: `${first.source} links to ${first.target}#${first.anchor}, but no matching ${first.kind} exists there — read the note to find the right anchor (or add it), then fix the link with \`edit_note\``,
    });
  }

  const orphans = f.orphans;
  if (orphans && orphans.items.length > 0) {
    const first = orphans.items[0]!;
    next_actions.push({
      description: `Connect orphan note: ${first.title}`,
      tool: 'link_notes',
      args: { source: first.path },
      reason: `${first.path} has no links in or out — pick a related note (e.g. \`search\` on its title) and pass it as \`target\` with a one-sentence \`context\``,
    });
  }

  const dupes = f.duplicate_names;
  if (dupes && dupes.items.length > 0) {
    const first = dupes.items[0]!;
    next_actions.push({
      description: `Disambiguate duplicate name: ${first.name}`,
      tool: 'move_note',
      args: { source: first.paths[1] ?? first.paths[0] },
      reason: `[[${first.name}]] matches ${first.paths.length} notes (${first.paths.join(', ')}) — rename one (supply \`destination\`) so bare links resolve unambiguously`,
    });
  }

  return { next_actions };
}

export function registerVaultHealthTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'vault_health',
    "Lint the vault: broken wiki-links (missing notes and missing attachment files), links to a `#heading` / `^block` that doesn't exist in the target note, orphan notes (no links in or out), notes without YAML frontmatter, near-empty notes, duplicate basenames, compared case-insensitively like Obsidian (ambiguous `[[name]]` targets), and index drift (files changed / added / deleted on disk since the last index pass). Read-only and cheap — computed from the existing index plus file mtimes, no re-parsing. Response is wrapped as `{data, context}`: `data.counts` / `data.bySeverity` summarise every finding, `data.findings.<check>.items` lists up to `limit` per check, and `context.next_actions` points at the tool that fixes the top issue (`create_note`, `read_note`, `link_notes`, `move_note`, `reindex`).",
    {
      checks: z
        .array(z.enum(HEALTH_CHECKS))
        .optional()
        .describe('Checks to run. Default: all of `broken_links`, `broken_anchors`, `orphans`, `missing_frontmatter`, `empty_notes`, `duplicate_names`, `index_drift`.'),
      scope: z
        .string()
        .optional()
        .describe('Restrict to notes under this vault-relative folder prefix. Broken links and broken anchors are scoped by their source note; a duplicate-name group is reported when any member is in scope.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max findings returned per check. Default ${DEFAULT_FINDINGS_LIMIT}. Counts always reflect the full total.`),
      minBodyChars: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(`\`empty_notes\` threshold: notes whose body (frontmatter excluded, whitespace trimmed) is shorter than this are reported. Default ${DEFAULT_MIN_BODY_CHARS}.`),
    },
    async (args) => {
      // First boot: nodes only land in the index once the embedder is up. With
      // an empty index and the embedder still loading there is nothing to lint
      // — every on-disk file would read as `not_indexed` — so return the same
      // preparing envelope the embedder-backed tools use.
      const realNotes = (
        ctx.db.prepare(`SELECT COUNT(*) AS n FROM nodes n WHERE ${notStub('n')}`).get() as { n: number }
      ).n;
      if (realNotes === 0) {
        const preparing = describeEmbedderPreparing(ctx);
        if (preparing) return preparing;
      }

      const report = await computeVaultHealth(ctx.db, ctx.config.vaultPath, args);
      if (ctx.reindexInProgress || !ctx.embedderReady()) {
        report.indexWarning = ctx.reindexInProgress
          ? 'A reindex is in progress — findings reflect a partially updated index. Re-run once it finishes.'
          : 'The embedding model is still loading, so on-disk changes since the last session have not been indexed yet — expect index_drift findings until startup catch-up completes.';
      }
      return { data: report, context: computeVaultHealthHints(report) };
    },
  );
}
