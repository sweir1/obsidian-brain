import {
  type GraphInstance,
  louvain,
  louvainModularity,
} from './graphology-compat.js';
import type { Community } from '../types.js';
import { pageRank } from './centrality.js';

/**
 * Mulberry32 — small, fast, well-distributed seeded PRNG. Returns a
 * function with `[0, 1)` output, identical sequence on every call when
 * given the same seed. Used to make Louvain (and any other graphology
 * algorithm that accepts an `rng` option) deterministic across runs.
 *
 * Without a seeded RNG, graphology-communities-louvain falls back to
 * `Math.random` for tie-breaking and node-ordering. Identical input
 * graphs then produce non-identical partitions (community count drifts
 * 5-30 across runs on a 12k-node vault), making any client-side
 * "did the partition change?" comparison impossible.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function rng(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Constant seed shared by every Louvain invocation in the server.
 *  Arbitrary value; what matters is that it stays constant across boots
 *  so the same graph produces the same partition. */
const LOUVAIN_SEED = 0xb5b51e1;

/**
 * Shape of a community-member node for summary generation — a `title` plus the
 * `tags` frontmatter list. Decoupled from the graphology graph so callers
 * without a live graph (e.g. the write-path prune in `store/communities.ts`)
 * can regenerate summaries from a SQLite lookup.
 */
export interface SummaryMember {
  title: string;
  tags: string[];
}

/**
 * Render a human-readable community summary from its live members.
 *
 * Shape: `"Key members: T1, T2, .... Tags: a, b, c. N nodes total."` — the
 * tag clause is omitted when no tags exist. Expects `members` to already be
 * sorted in display order (typically by PageRank descending).
 *
 * `totalCount` defaults to `members.length` but can be overridden when the
 * caller has some ids that aren't resolvable to a `SummaryMember` (e.g. a
 * half-stale cache row where an id no longer exists in the node store) and
 * wants the trailing `N nodes total` to reflect the authoritative count
 * rather than just the nodes that had title/tag data.
 *
 * Extracted so both the Louvain first-pass (`detectCommunities` below) and
 * the write-path cache prune (`pruneNodeFromCommunities` in the store)
 * produce identical strings. Without this, the `summary` field drifts out of
 * sync with `nodeIds` on every delete.
 */
export function buildSummary(
  members: SummaryMember[],
  totalCount: number = members.length,
): string {
  const topTitles = members.slice(0, 5).map((m) => m.title);

  const tagCounts = new Map<string, number>();
  for (const m of members) {
    for (const tag of m.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
  const tagStr = topTags.length > 0 ? ` Tags: ${topTags.join(', ')}.` : '';
  return `Key members: ${topTitles.join(', ')}.${tagStr} ${totalCount} nodes total.`;
}

/**
 * Louvain community detection with a heuristic summary per community.
 *
 * For each detected community we:
 *  - Sort members by PageRank and take the top member as the community label.
 *  - List the titles of the top 5 members.
 *  - Tally `frontmatter.tags` across members for a short tag summary.
 *
 * Accepts any graphology graph; callers typically pass an undirected
 * projection (Louvain requires undirected / can mutate weights otherwise).
 */
export function detectCommunities(
  graph: GraphInstance,
  resolution = 1.0,
): Community[] {
  const assignments = louvain(graph, {
    resolution,
    rng: mulberry32(LOUVAIN_SEED),
  });

  const communityMap = new Map<number, string[]>();
  for (const [nodeId, communityId] of Object.entries(assignments)) {
    const existing = communityMap.get(communityId) ?? [];
    existing.push(nodeId);
    communityMap.set(communityId, existing);
  }

  const pr = pageRank(graph);
  const communities: Community[] = [];

  for (const [id, nodeIds] of communityMap) {
    const sorted = [...nodeIds].sort((a, b) => (pr[b] ?? 0) - (pr[a] ?? 0));
    const topId = sorted[0] ?? '';
    const label = graph.hasNode(topId)
      ? (graph.getNodeAttribute(topId, 'title') as string)
      : topId;

    const members: SummaryMember[] = sorted.map((nid) => {
      const title = graph.hasNode(nid)
        ? (graph.getNodeAttribute(nid, 'title') as string)
        : nid;
      const fm = graph.hasNode(nid)
        ? (graph.getNodeAttribute(nid, 'frontmatter') as
            | Record<string, unknown>
            | undefined)
        : undefined;
      const tags = Array.isArray(fm?.tags) ? (fm!.tags as string[]) : [];
      return { title, tags };
    });

    const summary = buildSummary(members);

    communities.push({ id: Number(id), label, summary, nodeIds });
  }

  return communities;
}

/**
 * Score modularity of a community partition on an undirected graph.
 *
 * Louvain maximizes modularity — values close to 1 indicate strongly
 * separable communities; values near 0 (or negative) mean the partition
 * barely improves on random assignment. `detect_themes` warns callers
 * when this score drops below 0.3, which is the conventional "clusters
 * are meaningful" threshold in the network-science literature.
 *
 * Wraps graphology-communities-louvain's `.modularity` helper so callers
 * don't import louvain directly just for scoring.
 */
export function computeModularity(
  graph: GraphInstance,
  assignments: Record<string, number>,
): number {
  return louvainModularity(graph, {
    getNodeCommunity: (node) => assignments[node] ?? -1,
  });
}
