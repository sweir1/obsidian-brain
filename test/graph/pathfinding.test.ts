import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { KnowledgeGraph } from '../../src/graph/builder.js';
import {
  findNeighbors,
  findPaths,
  commonNeighbors,
  extractSubgraph,
} from '../../src/graph/pathfinding.js';

describe('graph/pathfinding', () => {
  let db: DatabaseHandle;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    db = openDb(':memory:');
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
    kg = KnowledgeGraph.fromStore(db);
  });

  afterEach(() => db.close());

  it('finds neighbors at depth 1', () => {
    const neighbors = findNeighbors(kg.graph(), 'a.md', 1);
    const ids = neighbors.map((n) => n.id);
    expect(ids).toContain('b.md');
    expect(ids).toContain('c.md');
    expect(ids).not.toContain('d.md');
  });

  it('finds neighbors at depth 2', () => {
    const neighbors = findNeighbors(kg.graph(), 'a.md', 2);
    const ids = neighbors.map((n) => n.id);
    expect(ids).toContain('b.md');
    expect(ids).toContain('c.md');
  });

  it('returns empty for unknown seed', () => {
    expect(findNeighbors(kg.graph(), 'missing.md', 1)).toEqual([]);
  });

  it('finds paths between connected nodes', () => {
    const paths = findPaths(kg.graph(), 'a.md', 'c.md', 3);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // Direct hop path has 1 edge.
    const directPath = paths.find((p) => p.length === 1);
    expect(directPath).toBeDefined();
    // Via-B path includes b.md.
    const viaB = paths.find((p) => p.nodes.includes('b.md'));
    expect(viaB).toBeDefined();
  });

  it('returns empty paths for disconnected nodes', () => {
    const paths = findPaths(kg.graph(), 'a.md', 'd.md', 3);
    expect(paths).toHaveLength(0);
  });

  it('returns empty paths for unknown endpoint', () => {
    expect(findPaths(kg.graph(), 'a.md', 'ghost.md', 3)).toEqual([]);
  });

  it('finds common neighbors', () => {
    const common = commonNeighbors(kg.graph(), 'a.md', 'b.md');
    expect(common.map((n) => n.id)).toContain('c.md');
  });

  it('extracts subgraph', () => {
    const sub = extractSubgraph(kg.graph(), 'a.md', 1);
    expect(sub.nodes.map((n) => n.id)).toContain('a.md');
    expect(sub.nodes.map((n) => n.id)).toContain('b.md');
    expect(sub.nodes.map((n) => n.id)).toContain('c.md');
    expect(sub.nodes.map((n) => n.id)).not.toContain('d.md');
    expect(sub.edges.length).toBeGreaterThan(0);
  });

  it('subgraph of unknown seed returns empty', () => {
    const sub = extractSubgraph(kg.graph(), 'ghost.md', 1);
    expect(sub.nodes).toEqual([]);
    expect(sub.edges).toEqual([]);
  });

  // findPaths traverses the undirected projection but resolves edge context
  // against the original DIRECTED graph via firstEdgeContext. When the path
  // walks an edge in reverse of its stored direction, firstEdgeContext's
  // forward-arm misses and the backward-arm resolves the context. Before
  // this test, the backward arm was unexercised — all existing path tests
  // walked edges in their stored forward direction.
  it('findPaths: backward-direction traversal still attaches edge context', () => {
    // Stored edge: a → b (directed). Query from b to a — the undirected
    // traversal finds [b, a], and firstEdgeContext(g, 'b', 'a') must fall
    // through to the backward arm to surface the context.
    const paths = findPaths(kg.graph(), 'b.md', 'a.md', 2);
    expect(paths.length).toBeGreaterThan(0);
    const direct = paths.find((p) => p.length === 1 && p.nodes[1] === 'a.md');
    expect(direct).toBeDefined();
    // The context must NOT be '' — that's what would come out if the backward
    // arm was broken or skipped.
    expect(direct!.edges[0].context).toBe('A links to B');
  });

  it('extractSubgraph: attaches context for edges stored in either direction', () => {
    // Subgraph edges enumerate via outNeighbors so they're all forward-
    // directed, but firstEdgeContext still runs per edge. Validate that the
    // existing outbound edges still surface their context — locks in that
    // we didn't regress the forward-arm while fixing the backward case.
    const sub = extractSubgraph(kg.graph(), 'a.md', 2);
    const aToB = sub.edges.find((e) => e.sourceId === 'a.md' && e.targetId === 'b.md');
    expect(aToB?.context).toBe('A links to B');
  });
});
