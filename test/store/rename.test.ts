import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode, getNode } from '../../src/store/nodes.js';
import {
  insertEdge,
  getEdgesBySource,
  getEdgesByTarget,
} from '../../src/store/edges.js';
import { setSyncMtime, getSyncMtime, getAllSyncPaths } from '../../src/store/sync.js';
import { upsertCommunity, getAllCommunities } from '../../src/store/communities.js';
import { renameNode } from '../../src/store/rename.js';

/**
 * Unit coverage for the v1.6.3 rename primitive. `renameNode` atomically
 * rewrites every row keyed on a node id — nodes.id, edges (in/out),
 * chunks.id / chunks.node_id, sync.path, communities.node_ids — so inbound
 * edges and graph membership survive a rename instead of getting dropped by
 * the pipeline's delete-then-upsert path.
 */
describe('renameNode', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('no-ops when oldId === newId', () => {
    upsertNode(db, { id: 'a.md', title: 'a', content: '', frontmatter: {} });
    renameNode(db, 'a.md', 'a.md');
    expect(getNode(db, 'a.md')).toBeDefined();
  });

  it('renames the node row and preserves title/content/frontmatter', () => {
    upsertNode(db, {
      id: 'old.md',
      title: 'Old Title',
      content: 'Body',
      frontmatter: { tag: 'x' },
    });
    renameNode(db, 'old.md', 'new.md');

    expect(getNode(db, 'old.md')).toBeUndefined();
    const moved = getNode(db, 'new.md');
    expect(moved).toBeDefined();
    expect(moved?.title).toBe('Old Title');
    expect(moved?.content).toBe('Body');
    expect(moved?.frontmatter).toEqual({ tag: 'x' });
  });

  it('preserves inbound edges across rename', () => {
    upsertNode(db, { id: 'target.md', title: 'T', content: '', frontmatter: {} });
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'target.md', context: 'x' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'target.md', context: 'y' });

    renameNode(db, 'target.md', 'renamed.md');

    expect(getEdgesByTarget(db, 'target.md')).toHaveLength(0);
    const inbound = getEdgesByTarget(db, 'renamed.md');
    expect(inbound).toHaveLength(2);
    expect(new Set(inbound.map((e) => e.sourceId))).toEqual(new Set(['a.md', 'b.md']));
    expect(new Set(inbound.map((e) => e.context))).toEqual(new Set(['x', 'y']));
  });

  it('preserves outbound edges across rename', () => {
    upsertNode(db, { id: 'src.md', title: 'S', content: '', frontmatter: {} });
    upsertNode(db, { id: 'x.md', title: 'X', content: '', frontmatter: {} });
    upsertNode(db, { id: 'y.md', title: 'Y', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'src.md', targetId: 'x.md', context: 'a' });
    insertEdge(db, { sourceId: 'src.md', targetId: 'y.md', context: 'b' });

    renameNode(db, 'src.md', 'src-renamed.md');

    expect(getEdgesBySource(db, 'src.md')).toHaveLength(0);
    const outbound = getEdgesBySource(db, 'src-renamed.md');
    expect(outbound).toHaveLength(2);
    expect(new Set(outbound.map((e) => e.targetId))).toEqual(new Set(['x.md', 'y.md']));
  });

  it('rewrites self-loop edges (source === target === oldId) to newId on both sides', () => {
    upsertNode(db, { id: 's.md', title: 'S', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 's.md', targetId: 's.md', context: 'self' });

    renameNode(db, 's.md', 's-new.md');

    expect(getEdgesBySource(db, 's.md')).toHaveLength(0);
    expect(getEdgesByTarget(db, 's.md')).toHaveLength(0);
    const self = getEdgesBySource(db, 's-new.md');
    expect(self).toHaveLength(1);
    expect(self[0]?.targetId).toBe('s-new.md');
  });

  it('rewrites chunk ids and chunk node_ids in one transaction', () => {
    upsertNode(db, { id: 'chunky.md', title: 'C', content: '', frontmatter: {} });
    // Insert two chunk rows directly; chunk id follows the `${nodeId}::${idx}` contract.
    db.prepare(
      `INSERT INTO chunks (id, node_id, chunk_index, heading, heading_level, content, content_hash, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('chunky.md::0', 'chunky.md', 0, 'H1', 1, 'body0', 'hash0', 1, 10);
    db.prepare(
      `INSERT INTO chunks (id, node_id, chunk_index, heading, heading_level, content, content_hash, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('chunky.md::1', 'chunky.md', 1, 'H2', 2, 'body1', 'hash1', 11, 20);

    renameNode(db, 'chunky.md', 'chunky-renamed.md');

    const rows = db
      .prepare('SELECT id, node_id, chunk_index FROM chunks ORDER BY chunk_index')
      .all() as Array<{ id: string; node_id: string; chunk_index: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'chunky-renamed.md::0', node_id: 'chunky-renamed.md', chunk_index: 0 });
    expect(rows[1]).toEqual({ id: 'chunky-renamed.md::1', node_id: 'chunky-renamed.md', chunk_index: 1 });
  });

  it('rewrites the sync table path', () => {
    upsertNode(db, { id: 'tracked.md', title: 'T', content: '', frontmatter: {} });
    setSyncMtime(db, 'tracked.md', 12345);

    renameNode(db, 'tracked.md', 'tracked-renamed.md');

    expect(getSyncMtime(db, 'tracked.md')).toBeUndefined();
    expect(getSyncMtime(db, 'tracked-renamed.md')).toBe(12345);
    expect(getAllSyncPaths(db)).toEqual(['tracked-renamed.md']);
  });

  it('rewrites community membership JSON arrays', () => {
    upsertNode(db, { id: 'alpha.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'beta.md', title: 'B', content: '', frontmatter: {} });
    upsertNode(db, { id: 'gamma.md', title: 'G', content: '', frontmatter: {} });

    upsertCommunity(db, {
      id: 1,
      label: 'cluster-one',
      summary: '',
      nodeIds: ['alpha.md', 'beta.md'],
    });
    upsertCommunity(db, {
      id: 2,
      label: 'cluster-two',
      summary: '',
      nodeIds: ['gamma.md'],
    });

    renameNode(db, 'alpha.md', 'alpha-renamed.md');

    const communities = getAllCommunities(db);
    const one = communities.find((c) => c.id === 1);
    const two = communities.find((c) => c.id === 2);
    expect(one?.nodeIds).toEqual(['alpha-renamed.md', 'beta.md']);
    expect(two?.nodeIds).toEqual(['gamma.md']);
  });

  it('ignores communities whose node_ids are not valid JSON (never throws)', () => {
    upsertNode(db, { id: 'n.md', title: 'N', content: '', frontmatter: {} });
    db.prepare(
      "INSERT INTO communities (id, label, summary, node_ids) VALUES (7, 'broken', '', '{not-json')",
    ).run();

    expect(() => renameNode(db, 'n.md', 'n-renamed.md')).not.toThrow();
  });
});
