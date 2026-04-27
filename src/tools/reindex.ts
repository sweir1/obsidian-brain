import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { pruneAllOrphanStubs } from '../store/nodes.js';

export function registerReindexTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'reindex',
    'Re-index the vault: re-embeds notes whose mtime changed, prunes orphan stubs, and re-runs community detection only when something actually changed. Pass `resolution` to force a Louvain rerun and tune cluster granularity (0.5 = fewer/broader clusters, 2.0 = more/finer); without it, a no-op vault skips Louvain entirely.',
    {
      resolution: z.number().positive().optional().describe('Louvain resolution. Omit to skip community detection on no-op reindexes. Pass a value to force-rerun: 1.0 = equal-weight clusters (default); 0.5 = fewer/broader; 2.0 = more/finer.'),
    },
    async (args) => {
      // `resolution` is now optional. When the caller omits it AND the
      // vault is unchanged, the indexer's no-op guard short-circuits the
      // Louvain rerun (saving ~25 s on a 10k-note vault). Passing an
      // explicit value still triggers refreshCommunities — that's the
      // "I want a different cluster shape" path.
      const { resolution } = args;
      await ctx.ensureEmbedderReady();
      // v1.7.20 C8: record a reason so index_status.lastReindexReasons isn't
      // empty after an explicit user-triggered reindex. Distinct from the
      // bootstrap-migration reasons that fire on model/schema change.
      ctx.lastManualReindexReason =
        resolution === undefined
          ? 'user-triggered reindex'
          : `user-triggered reindex (resolution: ${resolution})`;
      const stats = await ctx.pipeline.index(ctx.config.vaultPath, resolution);
      const stubsPruned = pruneAllOrphanStubs(ctx.db);
      return { ...stats, stubsPruned };
    },
  );
}
