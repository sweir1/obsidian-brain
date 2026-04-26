import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { KnowledgeGraph } from '../../src/graph/builder.js';

describe('KnowledgeGraph.fromStore', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
    // Build a small graph: A -> B -> C, A -> C, D (isolated)
    for (const [id, title] of [
      ['a.md', 'A'],
      ['b.md', 'B'],
      ['c.md', 'C'],
      ['d.md', 'D'],
    ]) {
      upsertNode(db, { id, title, content: '', frontmatter: {} });
    }
    insertEdge(db, { sourceId: 'a.md', targetId: 'b.md', context: 'A links to B' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'c.md', context: 'B links to C' });
    insertEdge(db, { sourceId: 'a.md', targetId: 'c.md', context: 'A links to C' });
  });

  afterEach(() => db.close());

  it('loads all nodes and edges from store', () => {
    const kg = KnowledgeGraph.fromStore(db);
    expect(kg.nodeCount()).toBe(4);
    expect(kg.edgeCount()).toBe(3);
  });

  it('exposes node title lookup', () => {
    const kg = KnowledgeGraph.fromStore(db);
    expect(kg.nodeTitle('a.md')).toBe('A');
    // Missing node falls back to id.
    expect(kg.nodeTitle('missing.md')).toBe('missing.md');
  });

  it('out/in neighbors reflect directed edges', () => {
    const kg = KnowledgeGraph.fromStore(db);
    expect(kg.outNeighbors('a.md').sort()).toEqual(['b.md', 'c.md']);
    expect(kg.inNeighbors('c.md').sort()).toEqual(['a.md', 'b.md']);
    expect(kg.outNeighbors('d.md')).toEqual([]);
    expect(kg.inNeighbors('d.md')).toEqual([]);
  });

  it('toUndirected drops direction and collapses to a simple graph', () => {
    const kg = KnowledgeGraph.fromStore(db);
    const u = kg.toUndirected();
    expect(u.order).toBe(4);
    // a->b and b->a would collapse; here we have a->b (single edge)
    expect(u.hasEdge('a.md', 'b.md') || u.hasEdge('b.md', 'a.md')).toBe(true);
  });

  it('dangling edges are silently dropped at build time', () => {
    insertEdge(db, { sourceId: 'a.md', targetId: 'ghost.md', context: 'x' });
    const kg = KnowledgeGraph.fromStore(db);
    // edge count should still be 3 because the dangling one is filtered
    expect(kg.edgeCount()).toBe(3);
  });

  // G1/G4/G5/G6 (v1.7.19): default-exclude broken-wikilink stub nodes from
  // the graph. Stubs (`frontmatter._stub: true`) are degree-1 dead ends that
  // fragment Louvain into thousands of trivial clusters and dominate
  // eigenvector-style centrality with empty-but-popular link targets.

  it('default excludes nodes with frontmatter._stub === true', () => {
    upsertNode(db, {
      id: '_stub/Ghost.md',
      title: 'Ghost',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'a.md', targetId: '_stub/Ghost.md', context: 'A → ghost' });

    const kg = KnowledgeGraph.fromStore(db);
    expect(kg.hasNode('_stub/Ghost.md')).toBe(false);
    // The edge to the stub is also dropped (target absent).
    expect(kg.edgeCount()).toBe(3);
    // Real nodes are still present.
    expect(kg.hasNode('a.md')).toBe(true);
    expect(kg.nodeCount()).toBe(4);
  });

  it('includeStubs: true keeps stub nodes in the graph (opt-in)', () => {
    upsertNode(db, {
      id: '_stub/Ghost.md',
      title: 'Ghost',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'a.md', targetId: '_stub/Ghost.md', context: 'A → ghost' });

    const kg = KnowledgeGraph.fromStore(db, { includeStubs: true });
    expect(kg.hasNode('_stub/Ghost.md')).toBe(true);
    expect(kg.nodeCount()).toBe(5);
    // The edge to the stub is now included.
    expect(kg.edgeCount()).toBe(4);
  });

  it('outgoing edges from a filtered stub are also dropped', () => {
    // Edge case: a stub that somehow has outgoing edges. Excluding the stub
    // node should also drop edges that originate from it (no orphan dangling
    // back into the graph).
    upsertNode(db, {
      id: '_stub/Hub.md',
      title: 'Hub',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: '_stub/Hub.md', targetId: 'a.md', context: 'stub → a' });

    const kg = KnowledgeGraph.fromStore(db);
    expect(kg.hasNode('_stub/Hub.md')).toBe(false);
    expect(kg.edgeCount()).toBe(3);
  });
});
