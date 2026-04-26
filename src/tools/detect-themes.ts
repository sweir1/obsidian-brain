import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { getAllCommunities, getCommunity } from '../store/communities.js';
import { getNode } from '../store/nodes.js';
import {
  buildSummary,
  computeModularity,
  type SummaryMember,
} from '../graph/communities.js';
import { KnowledgeGraph } from '../graph/builder.js';
import type { Community } from '../types.js';
import type { DatabaseHandle } from '../store/db.js';

const MODULARITY_WARN_THRESHOLD = 0.3;

interface ReconciledCommunity extends Community {
  staleMembersFiltered: number;
}

interface DetectThemesWarning {
  modularity: number;
  message: string;
}

export function registerDetectThemesTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'detect_themes',
    "List auto-detected topic clusters across the vault (served from the community-detection cache). Pass a theme id or label to drill into one cluster. To recompute with a different Louvain resolution, call `reindex({ resolution: X })` first — `detect_themes` itself is a read-only tool. Each returned cluster carries `staleMembersFiltered` — the number of cached `nodeIds` that no longer exist in the vault and were dropped on this read. A positive value means the cached community row is lagging; the filter also regenerates `summary` so it stays consistent with the filtered `nodeIds`. Broken-wikilink stub targets are excluded by default; pass `includeStubs: true` to include them. When the overall vault graph has LOW modularity (<0.3), the response includes `{ warning, modularity }` at the envelope top-level — the clusters aren't clearly separable on this graph and may not reflect meaningful themes.",
    {
      themeId: z.string().optional().describe('Drill into a single cluster by its id or label.'),
      includeStubs: z.boolean().optional().default(false).describe('Default `false`. Set `true` to include unresolved wiki-link targets (`frontmatter._stub: true`) in cluster membership. Older cached community data may still carry stub-dominated clusters until the next reindex regenerates the community table.'),
    },
    async (args) => {
      const { themeId, includeStubs } = args;
      const excludeStubs = !includeStubs;
      if (themeId !== undefined) {
        const community = getCommunity(ctx.db, themeId);
        if (community === null) return null;
        return reconcileCommunity(ctx.db, community, excludeStubs);
      }
      const clusters = getAllCommunities(ctx.db).map((c) =>
        reconcileCommunity(ctx.db, c, excludeStubs),
      );

      // Modularity guard (I). Recompute modularity from the live graph + the
      // cached community assignments so callers see a stable quality metric
      // for the current cache. Skip silently if the graph is too small to
      // score — tiny graphs surface as NaN/0 in graphology-metrics.
      let warning: DetectThemesWarning | undefined;
      try {
        const kg = KnowledgeGraph.fromStore(ctx.db);
        const undirected = kg.toUndirected();
        if (undirected.order >= 3 && undirected.size >= 1) {
          const assignments: Record<string, number> = {};
          for (const c of clusters) {
            for (const id of c.nodeIds) assignments[id] = c.id;
          }
          const modularity = computeModularity(undirected, assignments);
          if (
            Number.isFinite(modularity) &&
            modularity < MODULARITY_WARN_THRESHOLD
          ) {
            warning = {
              modularity,
              message: `communities not clearly separable on this vault (modularity: ${modularity.toFixed(3)}). Try rerunning with a different resolution, or accept that the graph is either too dense or too sparse for clean clustering.`,
            };
          }
        }
      } catch {
        // Never fail detect_themes because modularity couldn't be scored —
        // the clusters themselves are the product; the warning is advisory.
      }

      return warning === undefined
        ? clusters
        : { clusters, warning: warning.message, modularity: warning.modularity };
    },
  );
}

/**
 * Belt-and-braces read-path reconciliation. The write-path prune in
 * `pruneNodeFromCommunities` already keeps the cache fresh on `deleteNote`,
 * but a process that crashes mid-delete or a schema shared across older
 * sessions can leave ghost ids behind. Re-verify every member id against
 * the live node store and regenerate `summary` if the list shrank.
 *
 * Adds `staleMembersFiltered: number` so callers (and the verification test
 * in feedback) can detect the half-invalidated-cache condition cleanly.
 */
function reconcileCommunity(
  db: DatabaseHandle,
  community: Community,
  excludeStubs: boolean,
): ReconciledCommunity {
  const liveIds: string[] = [];
  const members: SummaryMember[] = [];
  for (const id of community.nodeIds) {
    const node = getNode(db, id);
    if (!node) continue;
    if (excludeStubs && node.frontmatter._stub === true) continue;
    liveIds.push(id);
    const tags = Array.isArray(node.frontmatter.tags)
      ? (node.frontmatter.tags as string[])
      : [];
    members.push({ title: node.title, tags });
  }

  const staleMembersFiltered = community.nodeIds.length - liveIds.length;
  if (staleMembersFiltered === 0) {
    return { ...community, staleMembersFiltered: 0 };
  }

  const summary = buildSummary(members, liveIds.length);
  return {
    ...community,
    nodeIds: liveIds,
    summary,
    staleMembersFiltered,
  };
}
