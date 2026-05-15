import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { computeSearchHints } from './hints.js';
import { describeEmbedderPreparing } from './preparing.js';
import type { SearchResult } from '../types.js';

export function registerSearchTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'search',
    'Search vault notes. `hybrid` (default) fuses semantic + full-text ranks via Reciprocal Rank Fusion — no tuning needed, best for most queries. `semantic` is concept-only (better for abstract/paraphrased queries). `fulltext` is literal-token (better when you know the exact phrase exists). Semantic search is chunk-level — results are deduped to one-per-note by default. Set `unique: "chunks"` to return chunk-level hits with `chunkHeading`, `chunkStartLine`, and `chunkExcerpt`; supported by `semantic` and `hybrid` modes. `fulltext` is note-level only and ignores `unique` (full-text chunk search is not yet supported). Response is wrapped as `{data, context}` where `context.next_actions` suggests the agent\'s most useful follow-up call (read top hit, explore connections, or retry with broader phrasing on zero hits).',
    {
      query: z.string().describe('Natural-language query or keyword phrase.'),
      mode: z.enum(['hybrid', 'semantic', 'fulltext']).optional().describe('Default `hybrid`. Semantic-only queries chunk vectors; fulltext-only queries FTS5.'),
      limit: z.number().int().positive().optional().describe('Max results to return. Default 20.'),
      unique: z.enum(['notes', 'chunks']).optional().describe('Default `"notes"` (one row per note). Set `"chunks"` for raw chunk rows with chunkHeading, chunkStartLine, chunkExcerpt.'),
    },
    async (args) => {
      const { query, mode, limit, unique } = args;
      const effectiveMode = mode ?? 'hybrid';
      const effectiveLimit = limit ?? 20;

      // Guard: semantic and hybrid both need the embedder. Return immediately
      // if it hasn't finished initialising rather than blocking (which could
      // cause MCP client timeouts on first-run model download or an
      // in-flight Ollama pull. v1.7.22 (O3/N2) surfaces the pull progress
      // via `describeEmbedderPreparing`).
      if (effectiveMode === 'semantic' || effectiveMode === 'hybrid') {
        const preparing = describeEmbedderPreparing(ctx);
        if (preparing) {
          // Append the search-specific fulltext fallback hint to the message.
          const hint = " You can fall back to search({mode:'fulltext'}) which works without the embedder.";
          return { ...preparing, message: preparing.message + hint };
        }
      }

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
          results = await ctx.search.hybrid(query, effectiveLimit, unique ?? 'notes');
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
