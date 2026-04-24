import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { KnowledgeGraph } from '../../src/graph/builder.js';
import {
  pageRank,
  betweennessCentralityTop,
} from '../../src/graph/centrality.js';

describe('graph/centrality', () => {
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

  it('PageRank returns a score for every node', () => {
    const scores = pageRank(kg.toUndirected());
    expect(Object.keys(scores).length).toBe(4);
    // Every connected node should have a finite score > 0.
    expect(scores['a.md']).toBeGreaterThan(0);
    expect(scores['b.md']).toBeGreaterThan(0);
    expect(scores['c.md']).toBeGreaterThan(0);
    // Isolated node D is filtered out of the connected subgraph and scored 0.
    expect(scores['d.md']).toBe(0);
  });

  it('PageRank tolerates isolated nodes (no NaN / Infinity)', () => {
    const scores = pageRank(kg.toUndirected());
    for (const v of Object.values(scores)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('PageRank on empty-ish graphs: all-isolated -> all zero', () => {
    // Fresh graph with no edges.
    const freshDb = openDb(':memory:');
    upsertNode(freshDb, { id: 'x.md', title: 'X', content: '', frontmatter: {} });
    upsertNode(freshDb, { id: 'y.md', title: 'Y', content: '', frontmatter: {} });
    const freshKg = KnowledgeGraph.fromStore(freshDb);
    const scores = pageRank(freshKg.toUndirected());
    expect(scores['x.md']).toBe(0);
    expect(scores['y.md']).toBe(0);
    freshDb.close();
  });

  it('betweennessCentralityTop returns top-N nodes', () => {
    const bridges = betweennessCentralityTop(kg.toUndirected(), 10);
    expect(bridges.length).toBeGreaterThan(0);
    // Each result has id/title/score
    for (const b of bridges) {
      expect(typeof b.id).toBe('string');
      expect(typeof b.title).toBe('string');
      expect(typeof b.score).toBe('number');
    }
  });

  it('betweennessCentralityTop respects limit', () => {
    const bridges = betweennessCentralityTop(kg.toUndirected(), 2);
    expect(bridges.length).toBeLessThanOrEqual(2);
  });
});

// The base suite only asserts betweenness result SHAPE (has id/title/score).
// That's the archetypal coverage-theatre pattern for algorithmic code: you
// hit every line without ever verifying the algorithm returns the right
// answer. These tests assert ORDERING on known topologies where the answer
// is determinate — a star hub must outscore its spokes, a chain's middle
// must outscore its endpoints. A bug in `betweennessFn` wiring (wrong graph
// projection, dropped edges, etc.) would surface here where it was invisible
// before.
describe('graph/centrality - ordering on known topologies', () => {
  function seedStar(hubId: string, spokeIds: string[]): {
    db: DatabaseHandle;
    kg: KnowledgeGraph;
  } {
    const db = openDb(':memory:');
    upsertNode(db, { id: hubId, title: hubId, content: '', frontmatter: {} });
    for (const s of spokeIds) {
      upsertNode(db, { id: s, title: s, content: '', frontmatter: {} });
      insertEdge(db, { sourceId: s, targetId: hubId, context: `${s}->${hubId}` });
    }
    return { db, kg: KnowledgeGraph.fromStore(db) };
  }

  function seedChain(ids: string[]): {
    db: DatabaseHandle;
    kg: KnowledgeGraph;
  } {
    const db = openDb(':memory:');
    for (const id of ids) upsertNode(db, { id, title: id, content: '', frontmatter: {} });
    for (let i = 0; i < ids.length - 1; i++) {
      insertEdge(db, { sourceId: ids[i], targetId: ids[i + 1], context: `${ids[i]}->${ids[i + 1]}` });
    }
    return { db, kg: KnowledgeGraph.fromStore(db) };
  }

  it('betweenness: star topology hub outscores every spoke', () => {
    const { db, kg } = seedStar('hub.md', ['s1.md', 's2.md', 's3.md', 's4.md', 's5.md']);
    try {
      const top = betweennessCentralityTop(kg.toUndirected(), 10);
      expect(top[0].id).toBe('hub.md');
      const hubScore = top.find((r) => r.id === 'hub.md')!.score;
      for (const r of top) {
        if (r.id === 'hub.md') continue;
        expect(hubScore).toBeGreaterThan(r.score);
      }
    } finally {
      db.close();
    }
  });

  it('betweenness: linear chain middle nodes outscore endpoints', () => {
    // A-B-C-D-E. B and C are on shortest paths between many pairs; A and E
    // are endpoints and sit on none.
    const { db, kg } = seedChain(['A.md', 'B.md', 'C.md', 'D.md', 'E.md']);
    try {
      const top = betweennessCentralityTop(kg.toUndirected(), 10);
      const score = (id: string) => top.find((r) => r.id === id)!.score;
      expect(score('C.md')).toBeGreaterThan(score('A.md'));
      expect(score('C.md')).toBeGreaterThan(score('E.md'));
      expect(score('B.md')).toBeGreaterThan(score('A.md'));
      expect(score('D.md')).toBeGreaterThan(score('E.md'));
    } finally {
      db.close();
    }
  });

  it('PageRank: star hub scores strictly higher than every spoke', () => {
    const { db, kg } = seedStar('hub.md', ['s1.md', 's2.md', 's3.md', 's4.md']);
    try {
      const scores = pageRank(kg.toUndirected());
      const hub = scores['hub.md'];
      for (const spoke of ['s1.md', 's2.md', 's3.md', 's4.md']) {
        expect(hub).toBeGreaterThan(scores[spoke]);
      }
    } finally {
      db.close();
    }
  });
});
