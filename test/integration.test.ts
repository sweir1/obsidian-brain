import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { openDb, type DatabaseHandle } from '../src/store/db.js';
import { getNode } from '../src/store/nodes.js';
import { getEdgesBySource } from '../src/store/edges.js';
import { getAllCommunities } from '../src/store/communities.js';
import { Embedder } from '../src/embeddings/embedder.js';
import { IndexPipeline } from '../src/pipeline/indexer.js';
import { KnowledgeGraph } from '../src/graph/builder.js';
import {
  findNeighbors,
  findPaths,
  commonNeighbors,
  extractSubgraph,
} from '../src/graph/pathfinding.js';
import {
  pageRank,
  betweennessCentralityTop,
} from '../src/graph/centrality.js';
import { Search } from '../src/search/unified.js';
import { resolveNodeName } from '../src/resolve/name-match.js';

const FIXTURE_VAULT = join(import.meta.dirname, 'fixtures', 'vault');

describe('Integration: full pipeline', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let kg: KnowledgeGraph;
  let search: Search;

  beforeAll(async () => {
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();

    const pipeline = new IndexPipeline(db, embedder);
    await pipeline.index(FIXTURE_VAULT);

    kg = KnowledgeGraph.fromStore(db);
    search = new Search(db, embedder);
  }, 180_000);

  afterAll(async () => {
    db.close();
    await embedder.dispose();
  });

  it('name resolution finds Alice by alias', () => {
    const matches = resolveNodeName('A. Smith', db);
    expect(matches).toHaveLength(1);
    expect(matches[0].nodeId).toBe('People/Alice Smith.md');
  });

  it('node lookup returns content and connections', () => {
    const node = getNode(db, 'People/Alice Smith.md');
    expect(node).toBeDefined();
    expect(node!.title).toBe('Alice Smith');
    const outgoing = getEdgesBySource(db, 'People/Alice Smith.md');
    expect(outgoing.length).toBeGreaterThan(0);
  });

  it('neighbors returns connected nodes', () => {
    const neighbors = findNeighbors(kg.graph(), 'People/Alice Smith.md', 1);
    const titles = neighbors.map((n) => n.title);
    expect(titles).toContain('Widget Theory');
  });

  it('semantic search finds relevant nodes', async () => {
    const results = await search.semantic('design pattern for components');
    expect(results.length).toBeGreaterThan(0);
  }, 60_000);

  it('fulltext search finds exact keywords', () => {
    const results = search.fulltext('resilient components');
    expect(results.length).toBeGreaterThan(0);
  });

  it('finds paths between Alice and Acme Project', () => {
    const paths = findPaths(
      kg.graph(),
      'People/Alice Smith.md',
      'Ideas/Acme Project.md',
      3,
    );
    expect(paths.length).toBeGreaterThan(0);
  });

  it('finds common neighbors between Alice and Bob', () => {
    const common = commonNeighbors(
      kg.graph(),
      'People/Alice Smith.md',
      'People/Bob Jones.md',
    );
    const titles = common.map((n) => n.title);
    expect(titles).toContain('Widget Theory');
  });

  it('extracts subgraph around Widget Theory', () => {
    const sub = extractSubgraph(kg.graph(), 'Concepts/Widget Theory.md', 1);
    expect(sub.nodes.length).toBeGreaterThan(1);
    expect(sub.edges.length).toBeGreaterThan(0);
  });

  it('communities are detected', () => {
    const communities = getAllCommunities(db);
    expect(communities.length).toBeGreaterThan(0);
  });

  it('bridges are computed', () => {
    const bridges = betweennessCentralityTop(kg.toUndirected(), 10);
    expect(bridges.length).toBeGreaterThan(0);
  });

  it('central nodes are computed (PageRank)', () => {
    const scores = pageRank(kg.toUndirected());
    // Every known vault node should have an entry.
    expect(Object.keys(scores).length).toBeGreaterThan(0);
    // Alice is central (degree > 0) so her score must be positive.
    expect(scores['People/Alice Smith.md']).toBeGreaterThan(0);
  });

  it('orphan node exists but is isolated', () => {
    const orphan = getNode(db, 'orphan.md');
    expect(orphan).toBeDefined();
    const neighbors = findNeighbors(kg.graph(), 'orphan.md', 1);
    expect(neighbors).toHaveLength(0);
  });
});
