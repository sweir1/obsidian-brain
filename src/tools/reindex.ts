import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { pruneAllOrphanStubs } from '../store/nodes.js';

export function registerReindexTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'reindex',
    'Re-index the vault: re-embeds notes whose mtime changed, re-runs community detection (default resolution 1.0), prunes orphan stubs (including any left behind by pre-v1.5.8 move/delete bugs). Pass `resolution` to tune cluster granularity (0.5 = fewer/broader clusters, 2.0 = more/finer).',
    {
      resolution: z.number().positive().default(1.0).describe('Louvain resolution. Default 1.0 (equal-weight clusters). 0.5 = fewer/broader; 2.0 = more/finer.'),
    },
    async (args) => {
      // `resolution` is always defined now (defaults to 1.0 in the Zod
      // schema). Passing it through keeps `index()` in its existing
      // "explicit intent => refresh communities" branch so bare `reindex()`
      // produces `communitiesDetected > 0` on a non-empty vault, matching
      // the rewritten description.
      const { resolution } = args;
      await ctx.ensureEmbedderReady();
      const stats = await ctx.pipeline.index(ctx.config.vaultPath, resolution);
      const stubsPruned = pruneAllOrphanStubs(ctx.db);
      return { ...stats, stubsPruned };
    },
  );
}
