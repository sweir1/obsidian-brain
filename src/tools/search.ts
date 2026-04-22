import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { computeSearchHints } from './hints.js';
import type { SearchResult } from '../types.js';

export function registerSearchTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'search',
    'Search vault notes. `hybrid` (default) fuses semantic + full-text ranks via Reciprocal Rank Fusion — no tuning needed, best for most queries. `semantic` is concept-only (better for abstract/paraphrased queries). `fulltext` is literal-token (better when you know the exact phrase exists). Since v1.4.0 semantic search is chunk-level — results are deduped to one-per-note by default. Set `unique: "chunks"` to return raw chunk rows (with `chunkHeading`, `chunkStartLine`, `chunkExcerpt`). Response is wrapped as `{data, context}` where `context.next_actions` suggests the agent\'s most useful follow-up call (read top hit, explore connections, or retry with broader phrasing on zero hits).',
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

      let results: SearchResult[];
      if (effectiveMode === 'fulltext') {
        results = ctx.search.fulltext(query, effectiveLimit);
      } else {
        await ctx.ensureEmbedderReady();
        if (effectiveMode === 'semantic') {
          results =
            unique === 'chunks'
              ? await ctx.search.semanticChunks(query, effectiveLimit, 'chunks')
              : await ctx.search.semantic(query, effectiveLimit);
        } else {
          results = await ctx.search.hybrid(query, effectiveLimit);
        }
      }

      const context = computeSearchHints(
        query,
        results.map((r) => ({ nodeId: r.nodeId, title: r.title, score: r.score })),
      );
      return { data: results, context };
    },
  );
}
