import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';

export function registerSearchTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'search',
    'Search vault notes. `hybrid` (default) fuses semantic + full-text ranks via Reciprocal Rank Fusion — no tuning needed, best for most queries. `semantic` is concept-only (better for abstract/paraphrased queries). `fulltext` is literal-token (better when you know the exact phrase exists). Since v1.4.0 semantic search is chunk-level — results are deduped to one-per-note by default. Set `unique: "chunks"` to return raw chunk rows (with `chunkHeading`, `chunkStartLine`, `chunkExcerpt`).',
    {
      query: z.string(),
      mode: z.enum(['hybrid', 'semantic', 'fulltext']).optional(),
      limit: z.number().int().positive().optional(),
      unique: z.enum(['notes', 'chunks']).optional(),
    },
    async (args) => {
      const { query, mode, limit, unique } = args;
      const effectiveMode = mode ?? 'hybrid';
      const effectiveLimit = limit ?? 20;

      if (effectiveMode === 'fulltext') {
        return ctx.search.fulltext(query, effectiveLimit);
      }

      await ctx.ensureEmbedderReady();

      if (effectiveMode === 'semantic') {
        if (unique === 'chunks') {
          return ctx.search.semanticChunks(query, effectiveLimit, 'chunks');
        }
        return ctx.search.semantic(query, effectiveLimit);
      }

      // hybrid
      return ctx.search.hybrid(query, effectiveLimit);
    },
  );
}
