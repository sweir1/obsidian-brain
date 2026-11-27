import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { allNodeIds, getNode } from '../../src/store/nodes.js';
import { collectMarkdownFiles } from '../../src/vault/parser.js';
import { clearVaultIgnoreCache, IGNORE_ENV, IGNORE_FILE_NAME } from '../../src/vault/ignore.js';
import { isIgnoredWatchPath } from '../../src/pipeline/watch-paths.js';
import { VaultWriter } from '../../src/vault/writer.js';
import { computeVaultHealth } from '../../src/tools/vault-health.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

/**
 * Issue #44, end to end: every path that decides what belongs in the index
 * honours the user's exclusions — full reindex, rule changes between runs,
 * the per-file path the watcher uses, direct writes from create_note /
 * link_notes, the live watcher's traversal, and vault_health.
 */

let vault: string;
let db: DatabaseHandle;
const savedEnv = process.env[IGNORE_ENV];

function write(rel: string, body: string): void {
  mkdirSync(join(vault, rel, '..'), { recursive: true });
  writeFileSync(join(vault, rel), body);
}

function setIgnoreFile(content: string | null): void {
  const p = join(vault, IGNORE_FILE_NAME);
  if (content === null) rmSync(p, { force: true });
  else writeFileSync(p, content);
  clearVaultIgnoreCache();
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'ob-exclusions-'));
  db = openDb(':memory:');
  bootstrap(db, new InstantMockEmbedder());
  delete process.env[IGNORE_ENV];
  clearVaultIgnoreCache();
  write('Home.md', 'See [[Scratch]] and [[Plan]].');
  write('Projects/Plan.md', 'The plan.');
  write('Claude outputs/Scratch.md', 'Transient output.');
  write('Claude outputs/nested/More.md', 'More output.');
});

afterEach(() => {
  db.close();
  try {
    chmodSync(join(vault, 'Claude outputs'), 0o755);
  } catch {
    /* not changed by this test */
  }
  rmSync(vault, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[IGNORE_ENV];
  else process.env[IGNORE_ENV] = savedEnv;
  clearVaultIgnoreCache();
});

describe('full reindex', () => {
  it('indexes nothing under an excluded folder (ignore file)', async () => {
    setIgnoreFile('Claude outputs/\n');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    const ids = allNodeIds(db);
    expect(ids).toContain('Home.md');
    expect(ids).toContain('Projects/Plan.md');
    expect(ids.filter((id) => id.startsWith('Claude outputs/'))).toEqual([]);
  });

  it('honours OBSIDIAN_BRAIN_IGNORE the same way', async () => {
    process.env[IGNORE_ENV] = 'Claude outputs/';
    clearVaultIgnoreCache();
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    expect(allNodeIds(db).filter((id) => id.startsWith('Claude outputs/'))).toEqual([]);
  });

  it('never descends into an excluded folder', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    setIgnoreFile('Claude outputs/\n');
    // Unreadable: any attempt to list it would throw EACCES.
    chmodSync(join(vault, 'Claude outputs'), 0o000);
    await expect(collectMarkdownFiles(vault)).resolves.toEqual(
      expect.arrayContaining(['Home.md', 'Projects/Plan.md']),
    );
  });

  it('removes notes that become excluded, and restores them when the rule goes', async () => {
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);
    expect(allNodeIds(db)).toContain('Claude outputs/Scratch.md');

    setIgnoreFile('Claude outputs/\n');
    await pipeline.index(vault);
    expect(allNodeIds(db)).not.toContain('Claude outputs/Scratch.md');
    expect(allNodeIds(db)).not.toContain('Claude outputs/nested/More.md');
    // Files on disk are untouched.
    expect(existsSync(join(vault, 'Claude outputs/Scratch.md'))).toBe(true);

    setIgnoreFile(null);
    await pipeline.index(vault);
    expect(allNodeIds(db)).toContain('Claude outputs/Scratch.md');
    expect(allNodeIds(db)).toContain('Claude outputs/nested/More.md');
  });

  it('excludes single files by pattern without touching the rest of their folder', async () => {
    write('Projects/Plan.draft.md', 'draft');
    setIgnoreFile('*.draft.md\n');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    const ids = allNodeIds(db);
    expect(ids).toContain('Projects/Plan.md');
    expect(ids).not.toContain('Projects/Plan.draft.md');
  });

  it('a negated rule keeps one note while excluding its siblings', async () => {
    setIgnoreFile('Claude outputs/*\n!Claude outputs/Scratch.md\n');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    const ids = allNodeIds(db);
    expect(ids).toContain('Claude outputs/Scratch.md');
    expect(ids).not.toContain('Claude outputs/nested/More.md');
  });
});

describe('single-note paths', () => {
  it('indexSingleNote never indexes an excluded note, and drops a stale one', async () => {
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);
    expect(getNode(db, 'Claude outputs/Scratch.md')).toBeDefined();

    setIgnoreFile('Claude outputs/\n');
    const res = await pipeline.indexSingleNote(vault, 'Claude outputs/Scratch.md', 'change');
    expect(res.indexed).toBe(false);
    expect(res.deleted).toBe(true);
    expect(getNode(db, 'Claude outputs/Scratch.md')).toBeUndefined();

    write('Claude outputs/New.md', 'brand new');
    const add = await pipeline.indexSingleNote(vault, 'Claude outputs/New.md', 'add');
    expect(add.indexed).toBe(false);
    expect(getNode(db, 'Claude outputs/New.md')).toBeUndefined();
  });

  it('create_note into an excluded folder writes the file but leaves it out of the index', () => {
    setIgnoreFile('Claude outputs/\n');
    const writer = new VaultWriter(vault, db);
    const rel = writer.createNode({ title: 'Made by tool', directory: 'Claude outputs', content: 'x' });
    expect(existsSync(join(vault, rel))).toBe(true);
    expect(getNode(db, rel)).toBeUndefined();
    // Control: the same call elsewhere is indexed.
    const ok = writer.createNode({ title: 'Kept', directory: 'Projects', content: 'x' });
    expect(getNode(db, ok)).toBeDefined();
  });

  it('link_notes from an excluded note adds no dangling edge', () => {
    setIgnoreFile('Claude outputs/\n');
    const writer = new VaultWriter(vault, db);
    writer.addLink('Claude outputs/Scratch.md', 'Home', 'see');
    const edges = db.prepare('SELECT COUNT(*) AS n FROM edges WHERE source_id = ?').get('Claude outputs/Scratch.md') as { n: number };
    expect(edges.n).toBe(0);
  });
});

describe('live watcher', () => {
  it('the predicate prunes the excluded folder, called with and without stats', () => {
    setIgnoreFile('Claude outputs/\n');
    const dir = { isDirectory: () => true };
    const file = { isDirectory: () => false };
    expect(isIgnoredWatchPath(vault, join(vault, 'Claude outputs'))).toBe(true);
    expect(isIgnoredWatchPath(vault, join(vault, 'Claude outputs'), dir)).toBe(true);
    expect(isIgnoredWatchPath(vault, join(vault, 'Claude outputs', 'Scratch.md'), file)).toBe(true);
    expect(isIgnoredWatchPath(vault, join(vault, 'Projects'), dir)).toBe(false);
    expect(isIgnoredWatchPath(vault, join(vault, 'Projects', 'Plan.md'), file)).toBe(false);
  });

  it('real chokidar never watches the excluded folder and reports no events from it', async () => {
    setIgnoreFile('Claude outputs/\n');
    const events: string[] = [];
    const watcher = chokidar.watch(vault, {
      ignored: (p: string, stats?: { isDirectory(): boolean }) => isIgnoredWatchPath(vault, p, stats),
      ignoreInitial: true,
    });
    try {
      await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
      const watchedDirs = Object.keys(watcher.getWatched());
      expect(watchedDirs.some((d) => d.includes('Claude outputs'))).toBe(false);
      expect(watchedDirs.some((d) => d.endsWith('Projects'))).toBe(true);

      watcher.on('add', (p) => events.push(p));
      write('Claude outputs/Fresh.md', 'should be ignored');
      write('Projects/Fresh.md', 'should be seen');
      const deadline = Date.now() + 5_000;
      while (!events.some((e) => e.endsWith(join('Projects', 'Fresh.md'))) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(events.some((e) => e.endsWith(join('Projects', 'Fresh.md')))).toBe(true);
      expect(events.some((e) => e.includes('Claude outputs'))).toBe(false);
    } finally {
      await watcher.close();
    }
  });
});

describe('vault_health', () => {
  it('a link to an excluded note is not broken, and excluded files are not "not_indexed"', async () => {
    setIgnoreFile('Claude outputs/\n');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    const report = await computeVaultHealth(db, vault, { checks: ['broken_links', 'index_drift'] });
    const broken = (report.findings.broken_links?.items ?? []) as Array<{ target: string }>;
    expect(broken.map((b) => b.target)).not.toContain('Scratch');
    const drift = (report.findings.index_drift?.items ?? []) as Array<{ path: string }>;
    expect(drift.filter((d) => d.path.startsWith('Claude outputs/'))).toEqual([]);
  });

  it('control: without the rule, a genuinely missing note is still broken', async () => {
    write('Home.md', 'See [[Nowhere]].');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    const report = await computeVaultHealth(db, vault, { checks: ['broken_links'] });
    const broken = (report.findings.broken_links?.items ?? []) as Array<{ target: string }>;
    expect(broken.map((b) => b.target)).toContain('Nowhere');
  });

  it('reports a still-indexed note under a new rule as `excluded` drift, not missing', async () => {
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);
    setIgnoreFile('Claude outputs/\n');
    const report = await computeVaultHealth(db, vault, { checks: ['index_drift'] });
    const drift = (report.findings.index_drift?.items ?? []) as Array<{ path: string; kind: string; severity: string }>;
    const scratch = drift.find((d) => d.path === 'Claude outputs/Scratch.md');
    expect(scratch).toMatchObject({ kind: 'excluded', severity: 'warn' });
    expect(drift.some((d) => d.kind === 'missing_on_disk')).toBe(false);
  });
});
