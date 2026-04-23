import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { KnowledgeGraph } from '../graph/builder.js';
import {
  pageRank,
  betweennessCentralityNormalized,
} from '../graph/centrality.js';
import { getCommunity } from '../store/communities.js';
import type { GraphInstance } from '../graph/graphology-compat.js';
import { Graph } from '../graph/graphology-compat.js';

interface RankedEntry {
  id: string;
  title: string;
  score: number;
}

function filterToCommunity(g: GraphInstance, nodeIds: Set<string>): GraphInstance {
  const out = new Graph({ multi: false, type: 'undirected' });
  g.forEachNode((id, attrs) => {
    if (nodeIds.has(id)) out.addNode(id, attrs);
  });
  g.forEachEdge((_e, _a, source, target) => {
    if (nodeIds.has(source) && nodeIds.has(target) && !out.hasEdge(source, target)) {
      out.addEdge(source, target);
    }
  });
  return out;
}

/**
 * Drop nodes (and their incident edges) from `g` that don't meet the
 * `predicate`. Used to filter out stubs (`_stub: true` frontmatter) and
 * low-inbound-link orphans before ranking.
 */
function filterNodes(
  g: GraphInstance,
  predicate: (id: string, attrs: Record<string, unknown>) => boolean,
): GraphInstance {
  const out = new Graph({ multi: false, type: 'undirected' });
  g.forEachNode((id, attrs) => {
    if (predicate(id, attrs)) out.addNode(id, attrs);
  });
  g.forEachEdge((_e, _a, source, target) => {
    if (out.hasNode(source) && out.hasNode(target) && !out.hasEdge(source, target)) {
      out.addEdge(source, target);
    }
  });
  return out;
}

export function registerRankNotesTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'rank_notes',
    "Rank notes by importance: 'influence' (densely-connected hubs), 'bridging' (notes that connect otherwise-separate topic clusters), or both. Credibility guards (I): by default, `influence` excludes notes with fewer than `minIncomingLinks: 2` incoming edges — this filters out random-orphan noise that makes PageRank feel meaningless on personal vaults. Pass `minIncomingLinks: 0` to see the unfiltered ranking. Bridging scores are normalized by graph size (divided by n*(n-1)/2) so values compare across vaults of different sizes — a bridging score of 0.5 means the same thing in any vault. Pass `includeStubs: false` to exclude unresolved wiki-link targets (`frontmatter._stub: true`) from the ranked set.",
    {
      metric: z.enum(['influence', 'bridging', 'both']).optional().describe('Ranking metric. Default `"both"`. `"influence"` = PageRank; `"bridging"` = betweenness centrality.'),
      limit: z.number().int().positive().optional().describe('Max results to return. Default 20.'),
      themeId: z.string().optional().describe('Restrict ranking to members of one theme cluster.'),
      includeStubs: z.boolean().optional().default(true).describe('Default `true`. Set `false` to exclude unresolved wiki-link targets from the ranked set.'),
      minIncomingLinks: z.number().int().nonnegative().optional().default(2).describe('Minimum incoming links for influence ranking. Default 2. Pass 0 to see unfiltered PageRank.'),
    },
    async (args) => {
      const { metric, limit, themeId, includeStubs, minIncomingLinks } = args;
      // Preserve the Zod default of 2 even when the registered handler is
      // called from a mock server that skips schema parsing (see test harness).
      const minIn = minIncomingLinks ?? 2;
      const kg = KnowledgeGraph.fromStore(ctx.db);
      // Compute incoming-edge counts from the directed graph BEFORE we collapse
      // to undirected — PageRank's "incoming link" semantics only makes sense
      // on the directed projection.
      const directed = kg.graph();
      const inCounts: Record<string, number> = {};
      directed.forEachNode((id) => {
        inCounts[id] = directed.inNeighbors(id).length;
      });

      let g = kg.toUndirected();

      // Match list-notes.ts (v1.2.2) — opt-out only when caller explicitly
      // passes `false`. undefined/true keeps stubs for backcompat.
      if (includeStubs === false) {
        g = filterNodes(g, (_id, attrs) => {
          const fm = attrs.frontmatter as Record<string, unknown> | undefined;
          return fm?._stub !== true;
        });
      }

      if (themeId !== undefined) {
        const community = getCommunity(ctx.db, themeId);
        if (!community) {
          throw new Error(`No theme found matching "${themeId}"`);
        }
        g = filterToCommunity(g, new Set(community.nodeIds));
      }

      const metric_ = metric ?? 'both';
      const lim = limit ?? 20;

      const influence = (): RankedEntry[] => {
        const pr = pageRank(g);
        return Object.entries(pr)
          .filter(([id]) => (inCounts[id] ?? 0) >= minIn)
          .sort((a, b) => b[1] - a[1])
          .slice(0, lim)
          .map(([id, score]) => ({
            id,
            title: g.hasNode(id) ? (g.getNodeAttribute(id, 'title') as string) : id,
            score,
          }));
      };

      const bridging = (): RankedEntry[] =>
        betweennessCentralityNormalized(g, lim);

      if (metric_ === 'influence') return influence();
      if (metric_ === 'bridging') return bridging();
      return { influence: influence(), bridging: bridging() };
    },
  );
}
