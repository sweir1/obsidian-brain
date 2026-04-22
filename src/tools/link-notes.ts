import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';

/**
 * `link_notes` — append a wiki-link from a source note to a target ref with
 * a short context sentence. Target is allowed to be an unknown/stub ref;
 * only the source has to exist in the index.
 */
export function registerLinkNotesTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'link_notes',
    "Add a wiki-link from one note to another with a context sentence describing why they're connected. Appends the link to the source note and records the edge in the graph so analytics pick it up.",
    {
      source: z.string(),
      target: z.string(),
      context: z.string().min(1),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const { source, target, context, dryRun } = args;

      const sourceId = resolveToSinglePath(source, ctx);

      if (dryRun === true) {
        // Mirror the line that addLink would append (writer.ts line 72).
        const wouldAppend = `\n${context} [[${target}]]`;
        return { dryRun: true, source: sourceId, target, context, wouldAppend };
      }

      ctx.writer.addLink(sourceId, target, context);

      const payload = { source: sourceId, target, context };

      try {
        await ctx.ensureEmbedderReady();
        await ctx.pipeline.index(ctx.config.vaultPath);
      } catch (err) {
        return { ...payload, reindex: 'failed', reindexError: String(err) };
      }

      return payload;
    },
  );
}

function resolveToSinglePath(name: string, ctx: ServerContext): string {
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
  return first.nodeId;
}
