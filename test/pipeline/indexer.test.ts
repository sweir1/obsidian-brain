import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getNode } from '../../src/store/nodes.js';
import { getEdgesBySource } from '../../src/store/edges.js';
import { getAllCommunities } from '../../src/store/communities.js';
import { Embedder } from '../../src/embeddings/embedder.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';

const FIXTURE_VAULT = join(import.meta.dirname, '..', 'fixtures', 'vault');

describe.sequential('IndexPipeline', () => {
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
    db.close();
    await embedder.dispose();
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

describe.sequential('IndexPipeline — forward-ref stub resolution', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-fwdref-'));
  }, 120_000);

  afterAll(async () => {
    db.close();
    await embedder.dispose();
    rmSync(tmpVault, { recursive: true, force: true });
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

describe.sequential('IndexPipeline.indexSingleNote', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;
  let tmpVault: string;

  beforeAll(async () => {
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
    tmpVault = mkdtempSync(join(tmpdir(), 'obsidian-brain-test-'));
  }, 120_000);

  afterAll(async () => {
    db.close();
    await embedder.dispose();
    rmSync(tmpVault, { recursive: true, force: true });
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
