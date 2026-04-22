import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import {
  upsertNode,
  getNode,
  allNodeIds,
  deleteNode,
  pruneOrphanStubs,
  pruneAllOrphanStubs,
  migrateStubToReal,
} from '../../src/store/nodes.js';
import { insertEdge, getEdgesBySource, getEdgesByTarget } from '../../src/store/edges.js';
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

  describe('pruneOrphanStubs', () => {
    it('deletes a stub with zero inbound edges', () => {
      upsertNode(db, { id: '_stub/orphan.md', title: 'Orphan', content: '', frontmatter: { _stub: true } });
      const pruned = pruneOrphanStubs(db, ['_stub/orphan.md']);
      expect(pruned).toBe(1);
      expect(getNode(db, '_stub/orphan.md')).toBeUndefined();
    });

    it('leaves a stub alone if it has one or more inbound edges', () => {
      upsertNode(db, { id: '_stub/linked.md', title: 'Linked', content: '', frontmatter: { _stub: true } });
      upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
      insertEdge(db, { sourceId: 'source.md', targetId: '_stub/linked.md', context: 'ref' });
      const pruned = pruneOrphanStubs(db, ['_stub/linked.md']);
      expect(pruned).toBe(0);
      expect(getNode(db, '_stub/linked.md')).toBeDefined();
    });

    it('ignores ids that do not start with _stub/', () => {
      upsertNode(db, { id: 'regular.md', title: 'Regular', content: '', frontmatter: { _stub: true } });
      const pruned = pruneOrphanStubs(db, ['regular.md']);
      expect(pruned).toBe(0);
      expect(getNode(db, 'regular.md')).toBeDefined();
    });

    it('ignores nodes whose frontmatter._stub is not set', () => {
      upsertNode(db, { id: '_stub/notstub.md', title: 'Not a stub', content: '', frontmatter: {} });
      const pruned = pruneOrphanStubs(db, ['_stub/notstub.md']);
      expect(pruned).toBe(0);
      expect(getNode(db, '_stub/notstub.md')).toBeDefined();
    });
  });

  describe('pruneAllOrphanStubs', () => {
    it('sweeps and removes all orphan stubs', () => {
      upsertNode(db, { id: '_stub/a.md', title: 'A', content: '', frontmatter: { _stub: true } });
      upsertNode(db, { id: '_stub/b.md', title: 'B', content: '', frontmatter: { _stub: true } });
      upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
      // b has an inbound edge — should survive
      insertEdge(db, { sourceId: 'source.md', targetId: '_stub/b.md', context: 'ref' });
      const pruned = pruneAllOrphanStubs(db);
      expect(pruned).toBe(1);
      expect(getNode(db, '_stub/a.md')).toBeUndefined();
      expect(getNode(db, '_stub/b.md')).toBeDefined();
    });
  });

  describe('migrateStubToReal', () => {
    it('repoints inbound edges from stub to real node and deletes the stub', () => {
      upsertNode(db, { id: '_stub/note.md', title: 'Stub', content: '', frontmatter: { _stub: true } });
      upsertNode(db, { id: 'real/note.md', title: 'Real', content: '', frontmatter: {} });
      upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
      insertEdge(db, { sourceId: 'source.md', targetId: '_stub/note.md', context: 'ref' });

      migrateStubToReal(db, '_stub/note.md', 'real/note.md');

      expect(getNode(db, '_stub/note.md')).toBeUndefined();
      const inbound = getEdgesByTarget(db, 'real/note.md');
      expect(inbound).toHaveLength(1);
      expect(inbound[0].sourceId).toBe('source.md');
    });

    it('is a no-op when the stub id does not exist', () => {
      upsertNode(db, { id: 'real/note.md', title: 'Real', content: '', frontmatter: {} });
      // Should not throw
      expect(() => migrateStubToReal(db, '_stub/missing.md', 'real/note.md')).not.toThrow();
    });

    it('is a no-op when the id exists but is not a stub', () => {
      upsertNode(db, { id: '_stub/notstub.md', title: 'Not a stub', content: '', frontmatter: {} });
      upsertNode(db, { id: 'real/note.md', title: 'Real', content: '', frontmatter: {} });
      upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
      insertEdge(db, { sourceId: 'source.md', targetId: '_stub/notstub.md', context: 'ref' });

      migrateStubToReal(db, '_stub/notstub.md', 'real/note.md');

      // Node should still exist (not deleted), edges should be unchanged
      expect(getNode(db, '_stub/notstub.md')).toBeDefined();
      expect(getEdgesByTarget(db, '_stub/notstub.md')).toHaveLength(1);
      expect(getEdgesByTarget(db, 'real/note.md')).toHaveLength(0);
    });
  });
});
