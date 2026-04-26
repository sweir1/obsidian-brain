import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { KnowledgeGraph } from '../graph/builder.js';
import { findPaths, commonNeighbors } from '../graph/pathfinding.js';
import type { NameMatch } from '../types.js';
import type { DatabaseHandle } from '../store/db.js';

function resolveOrThrow(name: string, db: DatabaseHandle): NameMatch {
  const matches = resolveNodeName(name, db);
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
  return first;
}

export function registerFindPathBetweenTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'find_path_between',
    'Find link paths between two notes. Returns all simple paths up to maxDepth edges, optionally including their shared neighbors. Broken-wikilink stub nodes are excluded by default — they are degree-1 dead ends in the undirected graph and will block legitimate paths if left in. Pass `includeStubs: true` to include them.',
    {
      from: z.string().describe('Source note (path or fuzzy match).'),
      to: z.string().describe('Target note (path or fuzzy match).'),
      maxDepth: z.number().int().positive().optional().describe('Maximum path length in hops. Default 3.'),
      includeCommon: z.boolean().optional().describe('Also return notes that both `from` and `to` link to (shared neighbors).'),
      includeStubs: z.boolean().optional().describe('Default `false`. Set `true` to include broken-wikilink stub nodes (`frontmatter._stub: true`) in the path search.'),
    },
    async (args) => {
      const { from, to, maxDepth, includeCommon, includeStubs } = args;
      const fromMatch = resolveOrThrow(from, ctx.db);
      const toMatch = resolveOrThrow(to, ctx.db);

      const kg = KnowledgeGraph.fromStore(ctx.db, { includeStubs });
      const g = kg.graph();
      const paths = findPaths(g, fromMatch.nodeId, toMatch.nodeId, maxDepth ?? 3);
      if (includeCommon) {
        const common = commonNeighbors(g, fromMatch.nodeId, toMatch.nodeId);
        return { paths, common };
      }
      return { paths };
    },
  );
}
