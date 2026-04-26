import { Graph, type GraphInstance } from './graphology-compat.js';
import type { DatabaseHandle } from '../store/db.js';
import { allNodeIds, getNode } from '../store/nodes.js';
import { getEdgesBySource } from '../store/edges.js';

/**
 * Thin wrapper around a graphology instance built from the SQLite store.
 *
 * Only holds construction + basic accessors. Pure algorithmic operations
 * (paths, centrality, communities) live in sibling modules and accept the
 * graphology instance directly — call `graph()` to get it.
 */
export class KnowledgeGraph {
  private readonly g: GraphInstance;

  private constructor(g: GraphInstance) {
    this.g = g;
  }

  /**
   * Build a directed multigraph from the store. Adds every node (with title
   * + frontmatter as attributes so community tag summaries work), then every
   * edge whose target exists as a node (dangling edges are silently dropped).
   *
   * `includeStubs` (default `false`): when `true`, includes broken-wikilink
   * stub nodes (`frontmatter._stub: true`) in the graph. Stubs have only one
   * incoming edge each and no outgoing edges, so leaving them in fragments
   * Louvain into thousands of trivial singleton clusters and dominates
   * eigenvector-style centrality with popular-but-empty link targets.
   * Default-excluding makes every graph tool (`detect_themes`, `rank_notes`,
   * `find_connections`, `find_path_between`) operate on the connected
   * "real-notes" graph by default. Pass `{ includeStubs: true }` to opt back
   * into the legacy behaviour.
   */
  static fromStore(
    db: DatabaseHandle,
    options: { includeStubs?: boolean } = {},
  ): KnowledgeGraph {
    const includeStubs = options.includeStubs ?? false;
    const g = new Graph({ multi: true, type: 'directed' });
    const ids = allNodeIds(db);
    const skipped = new Set<string>();
    for (const id of ids) {
      const node = getNode(db, id);
      if (!node) continue;
      if (!includeStubs && node.frontmatter._stub === true) {
        skipped.add(id);
        continue;
      }
      g.addNode(id, {
        title: node.title,
        frontmatter: node.frontmatter,
      });
    }
    for (const id of ids) {
      if (skipped.has(id)) continue;
      for (const edge of getEdgesBySource(db, id)) {
        if (g.hasNode(edge.targetId)) {
          g.addEdge(edge.sourceId, edge.targetId, { context: edge.context });
        }
      }
    }
    return new KnowledgeGraph(g);
  }

  /** The underlying graphology instance — pass to pure analytics functions. */
  graph(): GraphInstance {
    return this.g;
  }

  nodeCount(): number {
    return this.g.order;
  }

  edgeCount(): number {
    return this.g.size;
  }

  hasNode(id: string): boolean {
    return this.g.hasNode(id);
  }

  nodeTitle(id: string): string {
    return this.g.hasNode(id) ? (this.g.getNodeAttribute(id, 'title') as string) : id;
  }

  outNeighbors(id: string): string[] {
    return this.g.outNeighbors(id);
  }

  inNeighbors(id: string): string[] {
    return this.g.inNeighbors(id);
  }

  /**
   * Collapse the directed multigraph into an undirected simple graph. Useful
   * for Louvain/PageRank/betweenness which expect undirected input.
   */
  toUndirected(): GraphInstance {
    return toUndirected(this.g);
  }
}

/**
 * Free function form of KnowledgeGraph#toUndirected for callers that already
 * have a raw graphology instance (e.g. the analytics modules).
 */
export function toUndirected(g: GraphInstance): GraphInstance {
  const u = new Graph({ multi: false, type: 'undirected' });
  g.forEachNode((id, attrs) => u.addNode(id, attrs));
  g.forEachEdge((_edge, _attrs, source, target) => {
    if (!u.hasEdge(source, target)) u.addEdge(source, target);
  });
  return u;
}
