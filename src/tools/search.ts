import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';

export function registerSearchTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'search',
    'Semantic search across vault notes by meaning (default), or full-text exact-match search. Returns top results with excerpts and scores. Semantic scores are `1 - cosine_distance` (range `(-1, 1]`; closer to 1 is more similar, negative means very dissimilar). Fulltext scores are BM25-based (no fixed range; higher is better) and excerpts wrap matches in `>>>term<<<` markers.',
    {
      query: z.string(),
      mode: z.enum(['semantic', 'fulltext']).optional(),
      limit: z.number().int().positive().optional(),
    },
    async (args) => {
      const { query, mode, limit } = args;
      if (mode === 'fulltext') {
        return ctx.search.fulltext(query, limit ?? 20);
      }
      await ctx.ensureEmbedderReady();
      return ctx.search.semantic(query, limit ?? 20);
    },
  );
}
