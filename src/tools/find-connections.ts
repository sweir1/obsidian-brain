import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { KnowledgeGraph } from '../graph/builder.js';
import { findNeighbors, extractSubgraph } from '../graph/pathfinding.js';

export function registerFindConnectionsTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'find_connections',
    'Find notes linked to (from or to) a given note, up to N hops. Optionally return the full subgraph instead of a flat list.',
    {
      name: z.string(),
      depth: z.number().int().positive().optional(),
      returnSubgraph: z.boolean().optional(),
    },
    async (args) => {
      const { name, depth, returnSubgraph } = args;
      const matches = resolveNodeName(name, ctx.db);
      if (matches.length === 0) {
        throw new Error(`No note found matching "${name}"`);
      }
      const first = matches[0]!;
      const ambiguous =
        matches.length > 1 &&
        (first.matchType === 'substring' ||
          first.matchType === 'case-insensitive' ||
          first.matchType === 'alias');
      if (ambiguous) {
        const candidates = matches
          .slice(0, 10)
          .map((m) => `- ${m.title} (${m.nodeId})`)
          .join('\n');
        throw new Error(
          `Multiple notes match "${name}". Please be more specific. Candidates:\n${candidates}`,
        );
      }

      const id = first.nodeId;
      const kg = KnowledgeGraph.fromStore(ctx.db);
      const g = kg.graph();
      const d = depth ?? 1;
      if (returnSubgraph) {
        return extractSubgraph(g, id, d, ctx.db);
      }
      return findNeighbors(g, id, d);
    },
  );
}
