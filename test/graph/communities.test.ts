import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { KnowledgeGraph } from '../../src/graph/builder.js';
import { detectCommunities } from '../../src/graph/communities.js';

describe('graph/communities', () => {
  let db: DatabaseHandle;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    db = openDb(':memory:');
    // Two tight clusters bridged by a single edge. Louvain should find >= 2 groups.
    const nodes: Array<[string, string, string[]]> = [
      ['a1.md', 'A1', ['group-a']],
      ['a2.md', 'A2', ['group-a']],
      ['a3.md', 'A3', ['group-a']],
      ['b1.md', 'B1', ['group-b']],
      ['b2.md', 'B2', ['group-b']],
      ['b3.md', 'B3', ['group-b']],
    ];
    for (const [id, title, tags] of nodes) {
      upsertNode(db, { id, title, content: '', frontmatter: { tags } });
    }
    // Dense intra-cluster.
    insertEdge(db, { sourceId: 'a1.md', targetId: 'a2.md', context: '' });
    insertEdge(db, { sourceId: 'a2.md', targetId: 'a3.md', context: '' });
    insertEdge(db, { sourceId: 'a3.md', targetId: 'a1.md', context: '' });
    insertEdge(db, { sourceId: 'b1.md', targetId: 'b2.md', context: '' });
    insertEdge(db, { sourceId: 'b2.md', targetId: 'b3.md', context: '' });
    insertEdge(db, { sourceId: 'b3.md', targetId: 'b1.md', context: '' });
    // Single bridge edge.
    insertEdge(db, { sourceId: 'a1.md', targetId: 'b1.md', context: '' });
    kg = KnowledgeGraph.fromStore(db);
  });

  afterEach(() => db.close());

  it('detectCommunities partitions nodes into groups', () => {
    const communities = detectCommunities(kg.toUndirected(), 1.0);
    expect(communities.length).toBeGreaterThan(0);
    // Every node should appear in exactly one community.
    const seen = new Set<string>();
    for (const c of communities) {
      for (const id of c.nodeIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(6);
  });

  it('each community has label, summary, and a non-empty nodeIds list', () => {
    const communities = detectCommunities(kg.toUndirected(), 1.0);
    for (const c of communities) {
      expect(typeof c.id).toBe('number');
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(typeof c.summary).toBe('string');
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.nodeIds.length).toBeGreaterThan(0);
    }
  });

  it('summary includes tags from frontmatter.tags tally', () => {
    const communities = detectCommunities(kg.toUndirected(), 1.0);
    const joined = communities.map((c) => c.summary).join(' ');
    // Tags from fixtures should appear somewhere in the summaries.
    expect(joined.toLowerCase()).toMatch(/group-a|group-b/);
  });

  // C7 (v1.7.19): Louvain was unseeded, producing different community
  // counts (5163 / 5161 / 5159 / 5188 / 5189) on identical input data
  // across runs. The compat wrapper now passes a seeded mulberry32 RNG.
  it('C7: detectCommunities is deterministic — identical input → identical partition', () => {
    const u1 = kg.toUndirected();
    const u2 = kg.toUndirected();
    const a = detectCommunities(u1, 1.0);
    const b = detectCommunities(u2, 1.0);

    expect(a.length).toBe(b.length);

    // Build (nodeId → communityId) maps for both partitions and assert
    // they're identical.
    const mapA = new Map<string, number>();
    const mapB = new Map<string, number>();
    for (const c of a) for (const id of c.nodeIds) mapA.set(id, c.id);
    for (const c of b) for (const id of c.nodeIds) mapB.set(id, c.id);

    expect(mapA.size).toBe(mapB.size);
    for (const [id, communityId] of mapA) {
      expect(mapB.get(id)).toBe(communityId);
    }
  });

  it('C7: determinism holds across many sequential runs', () => {
    const reference = detectCommunities(kg.toUndirected(), 1.0);
    const refMap = new Map<string, number>();
    for (const c of reference) for (const id of c.nodeIds) refMap.set(id, c.id);

    for (let i = 0; i < 5; i++) {
      const next = detectCommunities(kg.toUndirected(), 1.0);
      expect(next.length).toBe(reference.length);
      for (const c of next) {
        for (const id of c.nodeIds) {
          expect(refMap.get(id)).toBe(c.id);
        }
      }
    }
  });
});
