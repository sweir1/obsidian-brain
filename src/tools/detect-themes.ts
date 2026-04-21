import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { getAllCommunities, getCommunity } from '../store/communities.js';

export function registerDetectThemesTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'detect_themes',
    'List auto-detected topic clusters across the vault (served from the community-detection cache). Pass a theme id or label to drill into one cluster. To recompute with a different Louvain resolution, call `reindex({ resolution: X })` first — `detect_themes` itself is a read-only tool.',
    {
      themeId: z.string().optional(),
    },
    async (args) => {
      const { themeId } = args;
      if (themeId !== undefined) {
        return getCommunity(ctx.db, themeId);
      }
      return getAllCommunities(ctx.db);
    },
  );
}
