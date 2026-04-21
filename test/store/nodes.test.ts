import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import {
  upsertNode,
  getNode,
  allNodeIds,
  deleteNode,
} from '../../src/store/nodes.js';
import { insertEdge, getEdgesBySource } from '../../src/store/edges.js';
import { searchFullText } from '../../src/store/fulltext.js';

describe('store/nodes', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates schema on initialization', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('nodes');
    expect(tables).toContain('edges');
    expect(tables).toContain('communities');
    expect(tables).toContain('sync');
  });

  it('upserts and retrieves nodes', () => {
    upsertNode(db, {
      id: 'test.md',
      title: 'Test',
      content: 'Hello world',
      frontmatter: { type: 'test' },
    });
    const node = getNode(db, 'test.md');
    expect(node).toBeDefined();
    expect(node!.title).toBe('Test');
    expect(node!.frontmatter).toEqual({ type: 'test' });
  });

  it('updates existing nodes on re-upsert', () => {
    upsertNode(db, {
      id: 'test.md',
      title: 'Original',
      content: 'v1',
      frontmatter: {},
    });
    upsertNode(db, {
      id: 'test.md',
      title: 'Updated',
      content: 'v2',
      frontmatter: { key: 'value' },
    });
    const node = getNode(db, 'test.md');
    expect(node!.title).toBe('Updated');
    expect(node!.content).toBe('v2');
    expect(node!.frontmatter).toEqual({ key: 'value' });
  });

  it('lists all node IDs', () => {
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    expect(allNodeIds(db)).toEqual(expect.arrayContaining(['a.md', 'b.md']));
  });

  it('deletes a node and cascades to edges', () => {
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'b.md', context: 'link' });
    deleteNode(db, 'a.md');
    expect(getNode(db, 'a.md')).toBeUndefined();
    expect(getEdgesBySource(db, 'a.md')).toHaveLength(0);
  });

  it('performs full-text search via FTS5', () => {
    upsertNode(db, {
      id: 'test.md',
      title: 'Widget Theory',
      content: 'A framework for understanding component interactions',
      frontmatter: {},
    });
    const results = searchFullText(db, 'framework component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('test.md');
  });

  it('full-text search returns snippets', () => {
    upsertNode(db, {
      id: 'test.md',
      title: 'Widget Theory',
      content:
        'A framework for understanding component interactions in complex distributed systems',
      frontmatter: {},
    });
    const results = searchFullText(db, 'framework component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].excerpt).not.toBe('');
    expect(results[0].excerpt).toContain('framework');
  });

  it('full-text search is re-synced after re-upsert (no stale FTS rows)', () => {
    upsertNode(db, {
      id: 'test.md',
      title: 'Original Title',
      content: 'original content about foobar',
      frontmatter: {},
    });
    upsertNode(db, {
      id: 'test.md',
      title: 'New Title',
      content: 'updated content about quux',
      frontmatter: {},
    });
    // Old content should no longer be findable
    expect(searchFullText(db, 'foobar')).toHaveLength(0);
    // New content should be findable
    const results = searchFullText(db, 'quux');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('test.md');
  });

  it('deleteNode prunes the id from community node_ids (F1)', async () => {
    const { upsertCommunity, getAllCommunities } = await import('../../src/store/communities.js');
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    upsertNode(db, { id: 'c.md', title: 'C', content: '', frontmatter: {} });
    upsertCommunity(db, { id: 0, label: 'Cluster0', summary: '', nodeIds: ['a.md', 'b.md', 'c.md'] });
    upsertCommunity(db, { id: 1, label: 'Solo', summary: '', nodeIds: ['a.md'] });

    deleteNode(db, 'a.md');

    const all = getAllCommunities(db);
    const cluster0 = all.find((c) => c.id === 0);
    expect(cluster0).toBeDefined();
    expect(cluster0!.nodeIds).not.toContain('a.md');
    expect(cluster0!.nodeIds).toEqual(['b.md', 'c.md']);
    // Solo community had only 'a.md' — it should be removed entirely.
    expect(all.find((c) => c.id === 1)).toBeUndefined();
  });
});
