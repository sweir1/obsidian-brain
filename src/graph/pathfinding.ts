import type { GraphInstance } from './graphology-compat.js';
import type { PathResult, SubgraphResult } from '../types.js';
import { toUndirected } from './builder.js';
import type { DatabaseHandle } from '../store/db.js';
import { getNode } from '../store/nodes.js';

/**
 * Info returned for each neighbor discovered by BFS traversal.
 */
export interface NeighborInfo {
  id: string;
  title: string;
}

/**
 * BFS from `nodeId` up to `depth` hops (treating the graph as undirected by
 * unioning in/out neighbors). The seed itself is not returned. Returns [] if
 * the seed is not present.
 */
export function findNeighbors(
  graph: GraphInstance,
  nodeId: string,
  depth: number,
): NeighborInfo[] {
  if (!graph.hasNode(nodeId)) return [];
  const visited = new Set<string>([nodeId]);
  const result: NeighborInfo[] = [];
  const queue: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (d >= depth) continue;
    const neighborIds = new Set<string>([
      ...graph.outNeighbors(id),
      ...graph.inNeighbors(id),
    ]);
    for (const nid of neighborIds) {
      if (!visited.has(nid)) {
        visited.add(nid);
        result.push({
          id: nid,
          title: graph.getNodeAttribute(nid, 'title') as string,
        });
        queue.push({ id: nid, d: d + 1 });
      }
    }
  }
  return result;
}

/**
 * Find every simple path from `from` to `to` with at most `maxDepth` edges.
 * Treats the graph as undirected (paths may traverse edges either way).
 */
export function findPaths(
  graph: GraphInstance,
  from: string,
  to: string,
  maxDepth: number,
): PathResult[] {
  if (!graph.hasNode(from) || !graph.hasNode(to)) return [];
  const undirected = toUndirected(graph);
  const rawPaths = findAllSimplePaths(undirected, from, to, maxDepth);

  return rawPaths.map((nodePath) => {
    const edges: PathResult['edges'] = [];
    for (let i = 0; i < nodePath.length - 1; i++) {
      const src = nodePath[i]!;
      const tgt = nodePath[i + 1]!;
      edges.push({ sourceId: src, targetId: tgt, context: firstEdgeContext(graph, src, tgt) });
    }
    return { nodes: nodePath, edges, length: nodePath.length - 1 };
  });
}

/**
 * Intersection of the (undirected) neighborhoods of two nodes.
 */
export function commonNeighbors(
  graph: GraphInstance,
  a: string,
  b: string,
): Array<{ id: string; title: string }> {
  if (!graph.hasNode(a) || !graph.hasNode(b)) return [];
  const nA = new Set<string>([...graph.outNeighbors(a), ...graph.inNeighbors(a)]);
  const nB = new Set<string>([...graph.outNeighbors(b), ...graph.inNeighbors(b)]);
  const common: Array<{ id: string; title: string }> = [];
  for (const id of nA) {
    if (nB.has(id)) {
      common.push({ id, title: graph.getNodeAttribute(id, 'title') as string });
    }
  }
  return common;
}

/**
 * BFS-expand a seed node out to `depth` hops and return the induced subgraph
 * (nodes + every edge between visited nodes, directed as in the source).
 */
export function extractSubgraph(
  graph: GraphInstance,
  seed: string,
  depth: number,
  db?: DatabaseHandle,
): SubgraphResult {
  const visited = new Set<string>();
  if (!graph.hasNode(seed)) return { nodes: [], edges: [] };
  visited.add(seed);
  const queue: Array<{ id: string; d: number }> = [{ id: seed, d: 0 }];

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (d >= depth) continue;
    const all = new Set<string>([
      ...graph.outNeighbors(id),
      ...graph.inNeighbors(id),
    ]);
    for (const nid of all) {
      if (!visited.has(nid)) {
        visited.add(nid);
        queue.push({ id: nid, d: d + 1 });
      }
    }
  }

  // If a DB handle is supplied, enrich each node with its actual frontmatter
  // from the store. Without it, fall back to `{}` for backward compat.
  const nodes = [...visited].map((id) => {
    const stored = db ? getNode(db, id) : undefined;
    return {
      id,
      title: graph.getNodeAttribute(id, 'title') as string,
      frontmatter: (stored?.frontmatter ?? {}) as Record<string, unknown>,
    };
  });

  const edges: SubgraphResult['edges'] = [];
  for (const id of visited) {
    for (const nid of graph.outNeighbors(id)) {
      if (visited.has(nid)) {
        edges.push({ sourceId: id, targetId: nid, context: firstEdgeContext(graph, id, nid) });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Return the `context` attribute of the first edge from `src` to `tgt` (either
 * direction). Safe for multigraphs — uses edge keys instead of source/target
 * lookups, which fail on multigraphs. Returns '' when no edge exists.
 */
function firstEdgeContext(graph: GraphInstance, src: string, tgt: string): string {
  const forward = graph.hasEdge(src, tgt) ? graph.edges(src, tgt) : [];
  if (forward.length > 0) {
    return (graph.getEdgeAttribute(forward[0]!, 'context') as string) ?? '';
  }
  const backward = graph.hasEdge(tgt, src) ? graph.edges(tgt, src) : [];
  if (backward.length > 0) {
    return (graph.getEdgeAttribute(backward[0]!, 'context') as string) ?? '';
  }
  return '';
}

/**
 * Depth-limited simple-path enumeration via DFS with explicit visited set.
 * Ported 1:1 from the reference — kept private to this module.
 */
function findAllSimplePaths(
  graph: GraphInstance,
  from: string,
  to: string,
  maxDepth: number,
): string[][] {
  const results: string[][] = [];

  function dfs(
    current: string,
    target: string,
    path: string[],
    visited: Set<string>,
    depth: number,
  ): void {
    if (current === target) {
      results.push([...path]);
      return;
    }
    if (depth >= maxDepth) return;
    for (const neighbor of graph.neighbors(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        path.push(neighbor);
        dfs(neighbor, target, path, visited, depth + 1);
        path.pop();
        visited.delete(neighbor);
      }
    }
  }

  const visited = new Set<string>([from]);
  dfs(from, to, [from], visited, 0);
  return results;
}
