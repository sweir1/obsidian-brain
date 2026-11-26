import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureEdgesTargetFragmentColumn, openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getNode } from '../../src/store/nodes.js';
import { getEdgesBySource } from '../../src/store/edges.js';
import { getAllCommunities } from '../../src/store/communities.js';
import { Embedder } from '../../src/embeddings/embedder.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';

const FIXTURE_VAULT = join(import.meta.dirname, '..', 'fixtures', 'vault');

describe('IndexPipeline', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;

  beforeAll(async () => {
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 120_000);

  afterAll(async () => {
    if (db) db.close();
    if (embedder) await embedder.dispose();
  });

  it('indexes the fixture vault', async () => {
    const stats = await pipeline.index(FIXTURE_VAULT);
    expect(stats.nodesIndexed).toBeGreaterThan(0);
    expect(stats.edgesIndexed).toBeGreaterThan(0);

    const alice = getNode(db, 'People/Alice Smith.md');
    expect(alice).toBeDefined();
    expect(alice!.title).toBe('Alice Smith');

    const edges = getEdgesBySource(db, 'People/Alice Smith.md');
    expect(edges.length).toBeGreaterThan(0);
  }, 120_000);

  it('creates stub nodes for broken links', async () => {
    // Store retains state from the first test's index() call
    const edges = getEdgesBySource(db, 'Ideas/Acme Project.md');
    const stubEdge = edges.find((e) => e.targetId.includes('Nonexistent'));
    expect(stubEdge).toBeDefined();
  });

  it('detects communities', async () => {
    // Communities were detected during the first test's index() call
    const communities = getAllCommunities(db);
    expect(communities.length).toBeGreaterThan(0);
  });

  it('is incremental (skips unchanged files)', async () => {
    // Use a fresh store so the first call indexes everything.
    const freshDb = openDb(':memory:');
    const freshPipeline = new IndexPipeline(freshDb, embedder);

    const first = await freshPipeline.index(FIXTURE_VAULT);
    expect(first.nodesIndexed).toBeGreaterThan(0);

    const second = await freshPipeline.index(FIXTURE_VAULT);
    expect(second.nodesIndexed).toBe(0);
    expect(second.nodesSkipped).toBe(first.nodesIndexed);

    freshDb.close();
  }, 120_000);
});

describe('IndexPipeline — forward-ref stub resolution', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    // Create the tmp vault + DB FIRST so afterAll can always clean them up,
    // even if embedder.init() throws (e.g. on CI with a corrupt HF cache).
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-fwdref-'));
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 120_000);

  afterAll(async () => {
    if (db) db.close();
    if (embedder) await embedder.dispose();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it('resolves forward-reference stubs when real note is later created', async () => {
    // Step 1 + 2: write _src.md with [[_future]], index — stub + edge created
    writeFileSync(join(tmpVault, '_src.md'), '# Src\n\nSee [[_future]].\n');
    await pipeline.index(tmpVault);

    // Step 3: stub exists, edge from _src.md points to the stub
    expect(getNode(db, '_stub/_future.md')).toBeDefined();
    const edgesBefore = getEdgesBySource(db, '_src.md');
    expect(edgesBefore.some((e) => e.targetId === '_stub/_future.md')).toBe(true);

    // Step 4: write the real note
    writeFileSync(join(tmpVault, '_future.md'), '# Future\n\nNow I exist.\n');

    // Step 5: re-index
    await pipeline.index(tmpVault);

    // Step 6: edge now targets _future.md
    const edgesAfter = getEdgesBySource(db, '_src.md');
    expect(edgesAfter.some((e) => e.targetId === '_future.md')).toBe(true);
    expect(edgesAfter.some((e) => e.targetId === '_stub/_future.md')).toBe(false);

    // Step 7: stub is gone
    expect(getNode(db, '_stub/_future.md')).toBeUndefined();
  }, 120_000);
});

describe('IndexPipeline.indexSingleNote', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-test-'));
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 120_000);

  afterAll(async () => {
    if (db) db.close();
    if (embedder) await embedder.dispose();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it('adds a brand-new file', async () => {
    writeFileSync(
      join(tmpVault, 'one.md'),
      '# One\n\nFirst note with a [[two]] link.\n',
    );
    const result = await pipeline.indexSingleNote(tmpVault, 'one.md', 'add');
    expect(result.indexed).toBe(true);
    expect(getNode(db, 'one.md')).toBeDefined();
    expect(getEdgesBySource(db, 'one.md').length).toBe(1);
  }, 60_000);

  it('updates an existing file on change', async () => {
    writeFileSync(
      join(tmpVault, 'one.md'),
      '# One updated\n\nNo longer links anywhere.\n',
    );
    // bump mtime beyond the previous index's recorded mtime
    await new Promise((r) => setTimeout(r, 30));
    const result = await pipeline.indexSingleNote(tmpVault, 'one.md', 'change');
    expect(result.indexed).toBe(true);
    expect(getNode(db, 'one.md')?.title).toBe('one');
    expect(getEdgesBySource(db, 'one.md')).toHaveLength(0);
  }, 60_000);

  it('deletes a file on unlink', async () => {
    const result = await pipeline.indexSingleNote(tmpVault, 'one.md', 'unlink');
    expect(result.deleted).toBe(true);
    expect(getNode(db, 'one.md')).toBeUndefined();
  });

  it('skips indexing when mtime has not advanced', async () => {
    writeFileSync(join(tmpVault, 'stable.md'), '# Stable\n');
    const first = await pipeline.indexSingleNote(tmpVault, 'stable.md', 'add');
    expect(first.indexed).toBe(true);
    const second = await pipeline.indexSingleNote(
      tmpVault,
      'stable.md',
      'change',
    );
    expect(second.skipped).toBe(true);
    expect(second.indexed).toBe(false);
  }, 60_000);
});

/**
 * v1.6.2 — indexSingleNote migrates forward-reference stubs inline, matching
 * what `create_note` does. Without this the watcher leaves stub-target edges
 * forever, which breaks `move_note`'s link-rewrite step later on.
 */
describe('IndexPipeline.indexSingleNote — forward-stub migration', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-fwd-single-'));
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 120_000);

  afterAll(async () => {
    if (db) db.close();
    if (embedder) await embedder.dispose();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it('repoints stub-target inbound edges to the new real note when the target is added via the watcher path', async () => {
    // Cars.md links to BMW before BMW exists — a forward reference, which
    // becomes a stub + stub-target edge when indexed.
    writeFileSync(join(tmpVault, 'Cars.md'), '# Cars\n\nI drive a [[BMW]].\n');
    await pipeline.indexSingleNote(tmpVault, 'Cars.md', 'add');

    expect(getNode(db, '_stub/BMW.md')).toBeDefined();
    const before = getEdgesBySource(db, 'Cars.md');
    expect(before.some((e) => e.targetId === '_stub/BMW.md')).toBe(true);

    // Now BMW.md arrives via the watcher path (not via `create_note`).
    writeFileSync(join(tmpVault, 'BMW.md'), '# BMW\n\nReal note.\n');
    await pipeline.indexSingleNote(tmpVault, 'BMW.md', 'add');

    // The stub must have been migrated: stub gone, edge retargeted.
    expect(getNode(db, '_stub/BMW.md')).toBeUndefined();
    const after = getEdgesBySource(db, 'Cars.md');
    expect(after.some((e) => e.targetId === 'BMW.md')).toBe(true);
    expect(after.some((e) => e.targetId === '_stub/BMW.md')).toBe(false);
  }, 120_000);
});

/**
 * v1.6.5 — heading / block-anchor stub lifecycle. The parser now splits
 * `[[Target#Section]]` into a bare stub id (`_stub/Target.md`) + an edge
 * fragment (`Section`), so forward-ref migration works the same for
 * `[[X]]` and `[[X#Section]]`. A renamed target rewrites the link text
 * with the suffix preserved, and the stored edge keeps pointing at the
 * (renamed) real node.
 */
describe('IndexPipeline — heading/anchor stub lifecycle (v1.6.5)', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-frag-'));
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 120_000);

  afterAll(async () => {
    if (db) db.close();
    if (embedder) await embedder.dispose();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it('splits [[BMW#Specs]] into bare stub + target_subpath="Specs"', async () => {
    writeFileSync(join(tmpVault, 'Cars.md'), '# Cars\n\nI drive a [[BMW#Specs]] model.\n');
    await pipeline.index(tmpVault);

    // Stub is BARE, not fragment-embedded.
    expect(getNode(db, '_stub/BMW.md')).toBeDefined();
    expect(getNode(db, '_stub/BMW#Specs.md')).toBeUndefined();

    const edges = getEdgesBySource(db, 'Cars.md');
    const edge = edges.find((e) => e.targetId === '_stub/BMW.md');
    expect(edge).toBeDefined();
    expect(edge?.targetSubpath).toBe('Specs');
  }, 120_000);

  it('migrates the fragment stub to a real note when the target is created', async () => {
    writeFileSync(join(tmpVault, 'BMW.md'), '# BMW\n\nReal note.\n');
    await pipeline.index(tmpVault);

    // Stub gone, edge retargeted at the real note, fragment preserved.
    expect(getNode(db, '_stub/BMW.md')).toBeUndefined();
    const edges = getEdgesBySource(db, 'Cars.md');
    const edge = edges.find((e) => e.targetId === 'BMW.md');
    expect(edge).toBeDefined();
    expect(edge?.targetSubpath).toBe('Specs');
  }, 120_000);

  it('handles block-reference anchors (^block) the same way', async () => {
    writeFileSync(join(tmpVault, 'Notes.md'), '# Notes\n\nSee [[BMW^abc123]] for the block.\n');
    await pipeline.index(tmpVault);

    const edges = getEdgesBySource(db, 'Notes.md');
    const edge = edges.find((e) => e.targetId === 'BMW.md');
    expect(edge).toBeDefined();
    expect(edge?.targetSubpath).toBe('abc123');
    // No fragment-embedded stub anywhere.
    expect(getNode(db, '_stub/BMW^abc123.md')).toBeUndefined();
  }, 120_000);
});

/**
 * Schema migration helpers exercised directly (unit). bootstrap()-level
 * integration coverage lives in test/pipeline/bootstrap.test.ts.
 */
describe('edges-column migrations (schema v4 + v5)', () => {
  it('ensureEdgesTargetFragmentColumn adds target_fragment on a pre-v4 DB and is idempotent', () => {
    const db = openDb(':memory:');
    // Fresh v5 DB creates `target_subpath`. To simulate a pre-v4 DB we have
    // to drop the v5 column AND anything the v4 migration would add.
    db.exec('ALTER TABLE edges DROP COLUMN target_subpath');

    db.prepare(
      "INSERT INTO nodes (id, title, content, frontmatter) VALUES ('a.md', 'A', 'x', '{}')",
    ).run();
    db.prepare(
      "INSERT INTO nodes (id, title, content, frontmatter) VALUES ('b.md', 'B', 'x', '{}')",
    ).run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();

    // Apply the v4 migration. Idempotent — second call is a no-op.
    ensureEdgesTargetFragmentColumn(db);
    ensureEdgesTargetFragmentColumn(db);

    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('target_fragment');

    // Existing row survived with target_fragment = NULL.
    const row = db
      .prepare('SELECT source_id, target_id, target_fragment FROM edges LIMIT 1')
      .get() as { source_id: string; target_id: string; target_fragment: string | null };
    expect(row).toEqual({ source_id: 'a.md', target_id: 'b.md', target_fragment: null });

    db.close();
  });

  it('ensureEdgesTargetFragmentColumn is a no-op on a v5+ DB (target_subpath present)', () => {
    const db = openDb(':memory:');
    // Fresh install is v5 — target_subpath already exists, target_fragment does not.
    ensureEdgesTargetFragmentColumn(db);
    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('target_subpath');
    expect(names).not.toContain('target_fragment'); // didn't re-add the old column
    db.close();
  });
});
