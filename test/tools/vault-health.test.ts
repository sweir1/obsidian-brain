/**
 * Unit tests for the `vault_health` MCP tool.
 *
 * Fixture = an in-memory index (nodes / edges / sync rows inserted directly,
 * the same shape the indexer writes) plus a temp vault directory on disk so
 * `index_drift` has real files + mtimes to compare against.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { setSyncMtime } from '../../src/store/sync.js';
import {
  registerVaultHealthTool,
  computeVaultHealth,
  computeVaultHealthHints,
  hasYamlFrontmatter,
  normaliseScope,
  extractAnchors,
  headingPathExists,
  normaliseHeading,
  DEFAULT_FINDINGS_LIMIT,
  DEFAULT_MIN_BODY_CHARS,
  type VaultHealthReport,
} from '../../src/tools/vault-health.js';
import type { ServerContext } from '../../src/context.js';
import { EXCLUDED_DIRS } from '../../src/vault/parser.js';
import { makeMockServer, unwrap } from '../helpers/mock-server.js';

const LONG_BODY = 'This note has a comfortably long body that clears the empty-note threshold easily.';

interface NoteSpec {
  id: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  /** Write the file to disk (default true). */
  onDisk?: boolean;
  /** Record a sync row (default true). */
  synced?: boolean;
  /** Make the disk copy newer than the indexed mtime. */
  modified?: boolean;
}

function addNote(db: DatabaseHandle, vault: string, spec: NoteSpec): void {
  upsertNode(db, {
    id: spec.id,
    title: spec.id.replace(/\.md$/, '').split('/').pop()!,
    content: spec.content,
    frontmatter: spec.frontmatter ?? {},
  });
  if (spec.onDisk !== false) {
    const abs = join(vault, spec.id);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, spec.content);
    // Pin a whole-second mtime so the sync comparison is exact.
    const t = new Date('2026-01-01T00:00:00Z');
    utimesSync(abs, t, t);
  }
  if (spec.synced !== false) {
    const mtime = spec.onDisk === false
      ? Date.parse('2026-01-01T00:00:00Z')
      : statSync(join(vault, spec.id)).mtimeMs;
    setSyncMtime(db, spec.id, spec.modified ? mtime - 60_000 : mtime);
  }
}

function addStub(db: DatabaseHandle, id: string): void {
  upsertNode(db, {
    id,
    title: id.replace(/^_stub\//, '').replace(/\.md$/, ''),
    content: '',
    frontmatter: { _stub: true },
  });
}

function link(db: DatabaseHandle, sourceId: string, targetId: string, targetSubpath: string | null = null): void {
  insertEdge(db, { sourceId, targetId, context: '', targetSubpath });
}

function writeDiskOnly(vault: string, rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, LONG_BODY);
}

function buildFixture(db: DatabaseHandle, vault: string): void {
  // Connected core: Hub <-> Projects/Alpha, Projects/Notes -> Hub.
  addNote(db, vault, {
    id: 'Hub.md',
    content: `${LONG_BODY} [[Projects/Alpha]] [[Missing Idea]] [[Missing Idea]] [[Ghost#Heading]] [[#Local]] #topic`,
    frontmatter: { tags: ['x'], inline_tags: ['topic'] },
    modified: true,
  });
  addNote(db, vault, {
    id: 'Projects/Alpha.md',
    content: `${LONG_BODY} [[Hub]] [[Missing Idea]] [[Sub/Thing]]`,
    frontmatter: { status: 'draft' },
  });
  addNote(db, vault, {
    id: 'Projects/Notes.md',
    content: `${LONG_BODY} [[Hub]]`,
    frontmatter: { title: 'Notes' },
  });
  // Disconnected notes.
  addNote(db, vault, { id: 'Archive/Notes.md', content: '' });
  addNote(db, vault, { id: 'Loner.md', content: 'status:: done', frontmatter: { status: 'done' } });
  addNote(db, vault, { id: 'SelfRef.md', content: `${LONG_BODY} [[SelfRef]] [[Nowhere]]`, frontmatter: { a: 1 } });
  // Indexed but deleted from disk.
  addNote(db, vault, { id: 'Gone.md', content: LONG_BODY, frontmatter: { a: 1 }, onDisk: false });
  // Indexed, on disk, but sync row cleared (pending embed retry) — NOT drift.
  addNote(db, vault, { id: 'Retry.md', content: `${LONG_BODY} [[Hub]]`, frontmatter: { a: 1 }, synced: false });

  // Stubs for unresolved targets.
  addStub(db, '_stub/Missing Idea.md');
  addStub(db, '_stub/Ghost.md');
  addStub(db, '_stub/Nowhere.md');
  addStub(db, '_stub/Sub/Thing.md');
  addStub(db, '_stub/.md');

  link(db, 'Hub.md', 'Projects/Alpha.md');
  link(db, 'Hub.md', '_stub/Missing Idea.md');
  link(db, 'Hub.md', '_stub/Missing Idea.md');
  link(db, 'Hub.md', '_stub/Ghost.md', 'Heading');
  link(db, 'Hub.md', '_stub/.md', 'Local');
  link(db, 'Projects/Alpha.md', 'Hub.md');
  link(db, 'Projects/Alpha.md', '_stub/Missing Idea.md');
  link(db, 'Projects/Alpha.md', '_stub/Sub/Thing.md');
  // Dangling edge with no node row at all (read_note treats it as unresolved).
  link(db, 'Projects/Alpha.md', 'Deleted.md');
  link(db, 'Projects/Notes.md', 'Hub.md');
  link(db, 'SelfRef.md', 'SelfRef.md');
  link(db, 'SelfRef.md', '_stub/Nowhere.md');
  link(db, 'Retry.md', 'Hub.md');

  // On disk only.
  writeDiskOnly(vault, 'Projects/Beta.md');
  // Excluded locations — the indexer never sees these, so neither should we.
  writeDiskOnly(vault, '.obsidian/workspace.md');
  writeDiskOnly(vault, 'attachments/pasted.md');
  writeDiskOnly(vault, '_FileOrganizer2000/inbox.md');
  writeDiskOnly(vault, 'node_modules/pkg/README.md');
  writeDiskOnly(vault, 'Projects/node_modules/dep/notes.md');
  writeDiskOnly(vault, '.hidden.md');
  writeDiskOnly(vault, 'image.png');
}

function makeCtx(db: DatabaseHandle, vault: string, over: Partial<ServerContext> = {}): ServerContext {
  return {
    db,
    config: { vaultPath: vault },
    embedderReady: () => true,
    reindexInProgress: false,
    initError: undefined,
    embedder: { providerName: () => 'transformers' },
    ...over,
  } as unknown as ServerContext;
}

async function callTool(ctx: ServerContext, args: Record<string, unknown> = {}): Promise<any> {
  const { server, registered } = makeMockServer();
  registerVaultHealthTool(server, ctx);
  expect(registered[0]!.name).toBe('vault_health');
  return unwrap(await registered[0]!.cb(args));
}

describe('tools/vault_health', () => {
  let db: DatabaseHandle;
  let vault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    vault = mkdtempSync(join(tmpdir(), 'vault-health-'));
    buildFixture(db, vault);
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('runs every check by default and wraps the report as {data, context}', async () => {
    const out = await callTool(makeCtx(db, vault));
    expect(out.data.checksRun).toEqual([
      'broken_links',
      'broken_anchors',
      'orphans',
      'missing_frontmatter',
      'empty_notes',
      'duplicate_names',
      'index_drift',
    ]);
    expect(Object.keys(out.data.findings).sort()).toEqual([...out.data.checksRun].sort());
    expect(out.data.scope).toBeNull();
    // 8 real notes; the 5 stubs are never counted.
    expect(out.data.notesScanned).toBe(8);
    expect(out.data.indexWarning).toBeUndefined();
    expect(Array.isArray(out.context.next_actions)).toBe(true);
    const total = out.data.bySeverity.error + out.data.bySeverity.warn + out.data.bySeverity.info;
    const sumCounts = Object.values(out.data.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(sumCounts);
    expect(out.data.summary).toContain(`${total} findings across 8 notes`);
  });

  it('broken_links: stub targets + dangling edges, grouped per (source, target)', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_links'] });
    const items = r.findings.broken_links!.items;
    expect(items).toEqual([
      { severity: 'warn', source: 'Hub.md', target: 'Ghost', kind: 'note', occurrences: 1 },
      { severity: 'warn', source: 'Hub.md', target: 'Missing Idea', kind: 'note', occurrences: 2 },
      { severity: 'warn', source: 'Projects/Alpha.md', target: 'Deleted', kind: 'note', occurrences: 1 },
      { severity: 'warn', source: 'Projects/Alpha.md', target: 'Missing Idea', kind: 'note', occurrences: 1 },
      { severity: 'warn', source: 'Projects/Alpha.md', target: 'Sub/Thing', kind: 'note', occurrences: 1 },
      { severity: 'warn', source: 'SelfRef.md', target: 'Nowhere', kind: 'note', occurrences: 1 },
    ]);
    // A legacy `_stub/.md` edge (index built before same-note links stopped
    // producing edges) is never reported as a broken link.
    expect(items.some((i) => i.target === '')).toBe(false);
  });

  it('orphans: ignores self-links and links to stubs; never reports stubs', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['orphans'] });
    const paths = r.findings.orphans!.items.map((i) => i.path);
    expect(paths).toEqual(['Archive/Notes.md', 'Gone.md', 'Loner.md', 'SelfRef.md']);
    expect(r.findings.orphans!.items[0]).toEqual({ severity: 'info', path: 'Archive/Notes.md', title: 'Notes' });
  });

  it('missing_frontmatter: discounts inline_tags and Dataview inline fields', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['missing_frontmatter'] });
    const paths = r.findings.missing_frontmatter!.items.map((i) => i.path);
    // Hub has YAML tags (+ inline_tags, ignored); Loner's only key is an inline field.
    expect(paths).toEqual(['Archive/Notes.md', 'Loner.md']);
  });

  it('empty_notes: default threshold, plus custom minBodyChars', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['empty_notes'] });
    expect(r.findings.empty_notes!.items).toEqual([
      { severity: 'warn', path: 'Archive/Notes.md', title: 'Notes', bodyChars: 0 },
      { severity: 'warn', path: 'Loner.md', title: 'Loner', bodyChars: 13 },
    ]);
    const none = await computeVaultHealth(db, vault, { checks: ['empty_notes'], minBodyChars: 0 });
    expect(none.findings.empty_notes!.count).toBe(0);
    const all = await computeVaultHealth(db, vault, { checks: ['empty_notes'], minBodyChars: 100_000 });
    expect(all.findings.empty_notes!.count).toBe(8);
    expect(DEFAULT_MIN_BODY_CHARS).toBe(50);
  });

  it('duplicate_names: groups case-insensitively (as Obsidian resolves links) and keeps exact paths', async () => {
    addNote(db, vault, { id: 'Inbox/notes.md', content: `${LONG_BODY} [[Hub]]`, frontmatter: { a: 1 } });
    addNote(db, vault, { id: 'Hub copy/HUB.md', content: `${LONG_BODY} [[Hub]]`, frontmatter: { a: 1 } });
    const r = await computeVaultHealth(db, vault, { checks: ['duplicate_names'] });
    expect(r.findings.duplicate_names!.items).toEqual([
      { severity: 'warn', name: 'HUB', paths: ['Hub copy/HUB.md', 'Hub.md'] },
      { severity: 'warn', name: 'Notes', paths: ['Archive/Notes.md', 'Inbox/notes.md', 'Projects/Notes.md'] },
    ]);
    // Scope still matches a group through any one member.
    const scoped = await computeVaultHealth(db, vault, { checks: ['duplicate_names'], scope: 'Inbox' });
    expect(scoped.findings.duplicate_names!.items.map((d) => d.name)).toEqual(['Notes']);
  });

  it('duplicate_names: same basename in multiple folders', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['duplicate_names'] });
    expect(r.findings.duplicate_names!.items).toEqual([
      { severity: 'warn', name: 'Notes', paths: ['Archive/Notes.md', 'Projects/Notes.md'] },
    ]);
  });

  it('index_drift: modified, not indexed, missing on disk; skips excluded dirs and unsynced notes', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['index_drift'] });
    const items = r.findings.index_drift!.items;
    expect(items.map((i) => [i.path, i.kind, i.severity])).toEqual([
      ['Gone.md', 'missing_on_disk', 'error'],
      ['Hub.md', 'modified_since_index', 'warn'],
      ['Projects/Beta.md', 'not_indexed', 'warn'],
    ]);
    const hub = items.find((i) => i.path === 'Hub.md')!;
    expect(hub.diskMtime! - hub.indexedMtime!).toBe(60_000);
    expect(items.find((i) => i.path === 'Gone.md')!.indexedMtime).toBeTypeOf('number');
    expect(items.find((i) => i.path === 'Projects/Beta.md')!.diskMtime).toBeTypeOf('number');
    expect(r.bySeverity).toEqual({ error: 1, warn: 2, info: 0 });
  });

  it('index_drift: skips every directory the parser excludes, including node_modules', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['index_drift'] });
    const paths = r.findings.index_drift!.items.map((i) => i.path);
    for (const dir of EXCLUDED_DIRS) {
      expect(paths.some((p) => p.split('/').includes(dir))).toBe(false);
    }
    expect(EXCLUDED_DIRS.has('node_modules')).toBe(true);
    // Scoping straight into an excluded dir finds nothing either.
    const scoped = await computeVaultHealth(db, vault, { checks: ['index_drift'], scope: 'Projects/node_modules' });
    expect(scoped.findings.index_drift!.count).toBe(0);
  });

  it('index_drift: missing_on_disk without a sync row omits indexedMtime', async () => {
    addNote(db, vault, { id: 'Phantom.md', content: LONG_BODY, onDisk: false, synced: false });
    const r = await computeVaultHealth(db, vault, { checks: ['index_drift'] });
    const phantom = r.findings.index_drift!.items.find((i) => i.path === 'Phantom.md')!;
    expect(phantom).toEqual({ severity: 'error', path: 'Phantom.md', kind: 'missing_on_disk' });
  });

  it('checks filter: runs only the requested checks, in canonical order', async () => {
    const out = await callTool(makeCtx(db, vault), { checks: ['orphans', 'broken_links'] });
    expect(out.data.checksRun).toEqual(['broken_links', 'orphans']);
    expect(Object.keys(out.data.findings).sort()).toEqual(['broken_links', 'orphans']);
    expect(out.data.counts).toEqual({ broken_links: 6, orphans: 4 });
    // Empty array behaves like "all".
    const all = await computeVaultHealth(db, vault, { checks: [] });
    expect(all.checksRun).toHaveLength(7);
  });

  it('scope: limits every check to the folder prefix', async () => {
    const r = await computeVaultHealth(db, vault, { scope: './Projects/' });
    expect(r.scope).toBe('Projects');
    expect(r.notesScanned).toBe(2);
    expect(r.findings.broken_links!.items.every((i) => i.source.startsWith('Projects/'))).toBe(true);
    expect(r.findings.broken_links!.count).toBe(3);
    expect(r.findings.orphans!.count).toBe(0);
    expect(r.findings.missing_frontmatter!.count).toBe(0);
    expect(r.findings.empty_notes!.count).toBe(0);
    // Ambiguity is vault-wide: the group is reported with both members.
    expect(r.findings.duplicate_names!.items[0]!.paths).toEqual(['Archive/Notes.md', 'Projects/Notes.md']);
    expect(r.findings.index_drift!.items.map((i) => i.path)).toEqual(['Projects/Beta.md']);
    expect(r.summary).toContain('in Projects/');
  });

  it('scope: a folder with no notes and no files reports nothing', async () => {
    const r = await computeVaultHealth(db, vault, { scope: 'Nope' });
    expect(r.notesScanned).toBe(0);
    expect(r.findings.duplicate_names!.count).toBe(0);
    expect(r.findings.index_drift!.count).toBe(0);
    expect(r.summary).toBe('No issues found across 0 notes in Nope/.');
  });

  it('scope: an excluded folder is never walked for drift', async () => {
    const r = await computeVaultHealth(db, vault, { scope: 'attachments', checks: ['index_drift'] });
    expect(r.findings.index_drift!.count).toBe(0);
  });

  it('limit: truncates items per check but keeps full counts and severity totals', async () => {
    const r = await computeVaultHealth(db, vault, { limit: 1 });
    expect(r.findings.broken_links!.items).toHaveLength(1);
    expect(r.findings.broken_links!.count).toBe(6);
    expect(r.findings.broken_links!.truncated).toBe(true);
    expect(r.findings.duplicate_names!.truncated).toBe(false);
    expect(r.findings.index_drift!.items).toHaveLength(1);
    expect(r.bySeverity.error).toBe(1);
    const full = await computeVaultHealth(db, vault, {});
    expect(full.bySeverity).toEqual(r.bySeverity);
    expect(full.findings.broken_links!.truncated).toBe(false);
    expect(DEFAULT_FINDINGS_LIMIT).toBe(50);
  });

  it('next_actions: reindex, create_note for the most-linked missing target, read_note, link_notes, move_note', async () => {
    const out = await callTool(makeCtx(db, vault));
    const actions = out.context.next_actions as Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
    expect(actions.map((a) => a.tool)).toEqual(['reindex', 'create_note', 'read_note', 'link_notes', 'move_note']);
    expect(actions[0]!.args).toEqual({});
    expect(actions[0]!.reason).toContain('3 files differ');
    expect(actions[1]!.args).toEqual({ title: 'Missing Idea', content: '' });
    expect(actions[1]!.reason).toContain('2 notes link to [[Missing Idea]]');
    // `[[#Local]]` in Hub (legacy `_stub/.md` form) has no matching heading in Hub itself.
    expect(actions[2]!.args).toEqual({ name: 'Hub.md', mode: 'full' });
    expect(actions[2]!.reason).toContain('Hub.md links to Hub.md#Local');
    expect(actions[3]!.args).toEqual({ source: 'Archive/Notes.md' });
    expect(actions[4]!.args).toEqual({ source: 'Projects/Notes.md' });
  });

  it('next_actions: a path-qualified missing target suggests a directory; singular wording', () => {
    const report = {
      findings: {
        broken_links: {
          count: 1,
          truncated: false,
          items: [{ severity: 'warn', source: 'a.md', target: 'Sub/Thing.md', kind: 'note', occurrences: 1 }],
        },
        index_drift: {
          count: 1,
          truncated: false,
          items: [{ severity: 'warn', path: 'b.md', kind: 'not_indexed' }],
        },
        duplicate_names: {
          count: 1,
          truncated: false,
          items: [{ severity: 'warn', name: 'X', paths: ['X.md'] }],
        },
      },
    } as unknown as VaultHealthReport;
    const ctx = computeVaultHealthHints(report);
    expect(ctx.next_actions![0]!.reason).toContain('1 file differ');
    expect(ctx.next_actions![1]!.args).toEqual({ title: 'Thing', content: '', directory: 'Sub' });
    expect(ctx.next_actions![1]!.reason).toContain('1 note links to');
    expect(ctx.next_actions![2]!.args).toEqual({ source: 'X.md' });
  });

  it('a clean vault returns no findings and no next_actions', async () => {
    const cleanDb = openDb(':memory:');
    const cleanVault = mkdtempSync(join(tmpdir(), 'vault-health-clean-'));
    try {
      addNote(cleanDb, cleanVault, { id: 'A.md', content: `${LONG_BODY} [[B]]`, frontmatter: { a: 1 } });
      addNote(cleanDb, cleanVault, { id: 'B.md', content: `${LONG_BODY} [[A]]`, frontmatter: { b: 1 } });
      link(cleanDb, 'A.md', 'B.md');
      link(cleanDb, 'B.md', 'A.md');
      const out = await callTool(makeCtx(cleanDb, cleanVault));
      expect(out.data.summary).toBe('No issues found across 2 notes.');
      expect(out.data.bySeverity).toEqual({ error: 0, warn: 0, info: 0 });
      expect(out.context.next_actions).toEqual([]);
      const one = await computeVaultHealth(cleanDb, cleanVault, { scope: 'A.md', checks: ['orphans'] });
      expect(one.summary).toBe('No issues found across 1 note in A.md/.');
    } finally {
      cleanDb.close();
      rmSync(cleanVault, { recursive: true, force: true });
    }
  });

  it('singular summary wording for exactly one finding', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['duplicate_names'] });
    expect(r.summary).toBe(
      '1 finding across 8 notes (0 error, 1 warn, 0 info): 1 duplicate_names.',
    );
  });

  it('indexWarning: flags a reindex in flight or an embedder still loading', async () => {
    const busy = await callTool(makeCtx(db, vault, { reindexInProgress: true }));
    expect(busy.data.indexWarning).toMatch(/reindex is in progress/);
    const loading = await callTool(makeCtx(db, vault, { embedderReady: () => false }));
    expect(loading.data.indexWarning).toMatch(/still loading/);
  });

  describe('empty index', () => {
    let emptyDb: DatabaseHandle;
    beforeEach(() => {
      emptyDb = openDb(':memory:');
    });
    afterEach(() => emptyDb.close());

    it('returns the preparing envelope while the embedder is still loading', async () => {
      const out = await callTool(makeCtx(emptyDb, vault, { embedderReady: () => false }));
      expect(out.status).toBe('preparing');
      expect(out.data).toBeUndefined();
    });

    it('returns the failed envelope when startup raised', async () => {
      const out = await callTool(
        makeCtx(emptyDb, vault, { embedderReady: () => false, initError: new Error('boom') }),
      );
      expect(out.status).toBe('failed');
      expect(out.message).toContain('boom');
    });

    it('runs normally once the embedder is ready (empty vault is simply empty)', async () => {
      const out = await callTool(makeCtx(emptyDb, vault));
      expect(out.data.notesScanned).toBe(0);
      // Every markdown file on disk is unindexed against an empty index.
      expect(out.data.counts.index_drift).toBe(8);
    });
  });
});

describe('vault_health broken_anchors', () => {
  let db: DatabaseHandle;
  let vault: string;

  const SPEC = [
    '# Overview',
    'Intro paragraph. ^intro',
    '',
    '## Design **Goals**',
    'Text.',
    '',
    '### API',
    '- an item ^List-Item',
    '',
    '## Trailing hashes ##',
    '',
    '```bash',
    '# Not A Heading',
    'echo hi ^fake',
    '```',
    '~~~',
    '## Also Not',
    '~~~',
    '#NoSpaceIsATag',
  ].join('\n');

  beforeEach(() => {
    db = openDb(':memory:');
    vault = mkdtempSync(join(tmpdir(), 'vault-health-anchors-'));
    addNote(db, vault, { id: 'Projects/Spec.md', content: SPEC, frontmatter: { a: 1 } });
    addNote(db, vault, {
      id: 'Src.md',
      content: [
        `${LONG_BODY} [[Projects/Spec^fake]] [[Projects/Spec^intro]] [[Projects/Spec^gone|alias]]`,
        '# Here',
        'Own block. ^own',
        // Same-note links: no edge exists for these, they're found in the body.
        '[[#Here]] ![[#Here]] [[#here|alias]] [[#Elsewhere]] [[#Elsewhere]] [[^own]] [[#^own]] [[^missing-blk]] [[#]]',
        '`[[#InCode]]`',
        '```',
        '[[#InFence]]',
        '```',
      ].join('\n'),
      frontmatter: { a: 1 },
    });
    addStub(db, '_stub/Nowhere.md');
    addStub(db, '_stub/.md');
    // A note with no anchors and no same-note links at all.
    addNote(db, vault, { id: 'Plain.md', content: LONG_BODY, frontmatter: { a: 1 } });
    const spec = 'Projects/Spec.md';
    // Resolving anchors.
    for (const sub of [
      'Overview',
      'design goals',
      '  Design   Goals ',
      'Design Goals#API',
      'Overview#API',
      'Overview#Design Goals#API',
      'Trailing hashes',
      '^intro',
      '^list-item',
      'intro', // bare `[[Spec^intro]]` form — separator dropped by the parser
    ]) {
      link(db, 'Src.md', spec, sub);
    }
    link(db, 'Src.md', spec, null); // plain link, no anchor
    link(db, 'Src.md', spec, ''); // empty subpath is ignored
    // Broken anchors.
    link(db, 'Src.md', spec, 'Missing Section');
    link(db, 'Src.md', spec, 'Missing Section');
    link(db, 'Src.md', spec, 'API#Design Goals'); // wrong nesting order
    link(db, 'Src.md', spec, 'Not A Heading'); // only inside a code fence
    link(db, 'Src.md', spec, 'Also Not'); // only inside a ~~~ fence
    link(db, 'Src.md', spec, '^gone');
    link(db, 'Src.md', spec, 'fake'); // bare `[[Spec^fake]]`; `^fake` only in code
    // `[[Src#Here]]` — a link into the source note by its own name is a
    // normal self-edge and is checked like any other target.
    link(db, 'Src.md', 'Src.md', 'Here');
    link(db, 'Src.md', 'Src.md', 'Not Here');
    // Legacy `_stub/.md` edges (index built before same-note links stopped
    // producing edges) are ignored — the body scan covers those links, so
    // counting the edge too would double-report.
    link(db, 'Src.md', '_stub/.md', 'Elsewhere');
    link(db, 'Src.md', '_stub/.md', 'Legacy Only');
    // Anchors on a missing note are broken_links' business, not ours.
    link(db, 'Src.md', '_stub/Nowhere.md', 'Whatever');
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('reports headings / blocks missing from the target note, with kind and occurrences', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_anchors'] });
    // Ordered by (source, target, anchor) in code-unit order, so block
    // anchors (`^…`) sort after capitalised headings.
    expect(r.findings.broken_anchors!.items).toEqual([
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: 'API#Design Goals', kind: 'heading', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: 'Also Not', kind: 'heading', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: 'Missing Section', kind: 'heading', occurrences: 2 },
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: 'Not A Heading', kind: 'heading', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: '^fake', kind: 'block', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Projects/Spec.md', anchor: '^gone', kind: 'block', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Src.md', anchor: 'Elsewhere', kind: 'heading', occurrences: 2 },
      { severity: 'warn', source: 'Src.md', target: 'Src.md', anchor: 'Not Here', kind: 'heading', occurrences: 1 },
      { severity: 'warn', source: 'Src.md', target: 'Src.md', anchor: '^missing-blk', kind: 'block', occurrences: 1 },
    ]);
    expect(r.bySeverity.warn).toBe(9);
  });

  it('scope applies to the source note', async () => {
    const inProjects = await computeVaultHealth(db, vault, { checks: ['broken_anchors'], scope: 'Projects' });
    expect(inProjects.findings.broken_anchors!.count).toBe(0);
    // Targets outside the scope are still read to resolve anchors.
    const srcOnly = await computeVaultHealth(db, vault, { checks: ['broken_anchors'], scope: 'Src.md' });
    expect(srcOnly.findings.broken_anchors!.count).toBe(9);
  });

  it('next_actions suggests read_note on the target', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_anchors'] });
    const hints = computeVaultHealthHints(r);
    expect(hints.next_actions).toEqual([
      expect.objectContaining({
        tool: 'read_note',
        args: { name: 'Projects/Spec.md', mode: 'full' },
        description: 'Check the headings in Projects/Spec.md',
      }),
    ]);
  });

  it('extractAnchors / headingPathExists / normaliseHeading edge cases', () => {
    const a = extractAnchors('#   \n# [[Linked|Shown]] and [md](http://x) `code` ==hl== ~~s~~\nline ^Blk-1');
    expect(a.headings.map((h) => h.norm)).toEqual(['', 'shown and md code hl s']);
    expect(a.blocks.has('blk-1')).toBe(true);
    expect(headingPathExists(a, [])).toBe(true);
    expect(headingPathExists(a, ['', ''])).toBe(true);
    expect(headingPathExists(a, ['Shown and md code hl s'])).toBe(true);
    expect(normaliseHeading('Q: what | now?')).toBe('q what now?');
    expect(normaliseHeading('[[Target]] notes')).toBe('target notes');
  });
});

describe('vault_health broken_links: attachments', () => {
  let db: DatabaseHandle;
  let vault: string;

  const touch = (rel: string): void => {
    const abs = join(vault, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
  };

  beforeEach(() => {
    db = openDb(':memory:');
    vault = mkdtempSync(join(tmpdir(), 'vault-health-attach-'));
    addNote(db, vault, {
      id: 'Notes/Page.md',
      content: [
        LONG_BODY,
        '![[diagram.png]] [[spec.pdf]] [[docs/manual.PDF]] [[./local.jpg]] [[../up.gif]]',
        '![[missing.png|300]] ![[missing.png]] [[nope/deep.svg#page=2]] [[../../escape.png]]',
        '[[x.png]] [[hidden.png]] [[vendored.png]] [[Board.canvas]]',
        '`![[in-code.png]]`',
        '```',
        '![[in-fence.png]]',
        '```',
      ].join('\n'),
      frontmatter: { a: 1 },
    });
    // A note literally named `x.png.md` — `[[x.png]]` links to it.
    addNote(db, vault, { id: 'x.png.md', content: `${LONG_BODY} [[./rootlocal.png]]`, frontmatter: { a: 1 } });
    addNote(db, vault, { id: 'Other/Ref.md', content: `${LONG_BODY} [[gone.pdf]]`, frontmatter: { a: 1 } });
    // Legacy attachment stub from an index built before attachments stopped
    // producing edges — never reported as a missing NOTE.
    addStub(db, '_stub/old.png.md');
    link(db, 'Notes/Page.md', '_stub/old.png.md');

    touch('attachments/diagram.png'); // the parser's excluded `attachments/` still resolves
    touch('Elsewhere/SPEC.pdf'); // basename fallback, case-insensitive
    touch('Docs/Manual.pdf'); // vault-relative path, case-insensitive
    touch('Notes/local.jpg'); // relative to the linking note
    touch('up.gif'); // `../` from Notes/ lands at the root
    touch('rootlocal.png'); // `./` from a root-level note
    touch('Boards/Board.canvas');
    touch('.obsidian/plugins/hidden.png'); // dot-folders never count
    touch('node_modules/pkg/vendored.png'); // nor the parser's other excluded dirs
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('reports linked / embedded files missing from disk, resolving like Obsidian', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_links'] });
    expect(r.findings.broken_links!.items).toEqual([
      { severity: 'warn', source: 'Notes/Page.md', target: '../../escape.png', kind: 'attachment', occurrences: 1 },
      { severity: 'warn', source: 'Notes/Page.md', target: 'hidden.png', kind: 'attachment', occurrences: 1 },
      { severity: 'warn', source: 'Notes/Page.md', target: 'missing.png', kind: 'attachment', occurrences: 2 },
      { severity: 'warn', source: 'Notes/Page.md', target: 'nope/deep.svg', kind: 'attachment', occurrences: 1 },
      { severity: 'warn', source: 'Notes/Page.md', target: 'vendored.png', kind: 'attachment', occurrences: 1 },
      { severity: 'warn', source: 'Other/Ref.md', target: 'gone.pdf', kind: 'attachment', occurrences: 1 },
    ]);
  });

  it('respects scope (by linking note) and limit', async () => {
    const scoped = await computeVaultHealth(db, vault, { checks: ['broken_links'], scope: 'Other' });
    expect(scoped.findings.broken_links!.items.map((i) => i.target)).toEqual(['gone.pdf']);
    const limited = await computeVaultHealth(db, vault, { checks: ['broken_links'], limit: 2 });
    expect(limited.findings.broken_links!.items).toHaveLength(2);
    expect(limited.findings.broken_links!.count).toBe(6);
    expect(limited.findings.broken_links!.truncated).toBe(true);
  });

  it('missing attachments get no create_note hint (no tool can create the file)', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_links'] });
    expect(computeVaultHealthHints(r).next_actions).toEqual([]);
  });

  it('a vault with no attachment links never reports attachment findings', async () => {
    const r = await computeVaultHealth(db, vault, { checks: ['broken_links'], scope: 'x.png.md' });
    expect(r.findings.broken_links!.count).toBe(0);
  });
});

describe('vault_health helpers', () => {
  it('normaliseScope strips ./ and slashes; blank → null', () => {
    expect(normaliseScope(undefined)).toBeNull();
    expect(normaliseScope('')).toBeNull();
    expect(normaliseScope(' / ')).toBeNull();
    expect(normaliseScope('.')).toBeNull();
    expect(normaliseScope('./a/b/')).toBe('a/b');
    expect(normaliseScope('a\\b')).toBe('a/b');
  });

  it('hasYamlFrontmatter: a YAML key wins unless the body defines it inline', () => {
    expect(hasYamlFrontmatter({}, '')).toBe(false);
    expect(hasYamlFrontmatter({ inline_tags: ['x'] }, '#x')).toBe(false);
    expect(hasYamlFrontmatter({ status: 'done' }, 'status:: done')).toBe(false);
    expect(hasYamlFrontmatter({ status: 'done' }, 'no inline field here')).toBe(true);
    expect(hasYamlFrontmatter({ 'a.b': 1 }, 'aXb:: 1')).toBe(true);
  });
});
