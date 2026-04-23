import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { deleteNote, type DeleteResult } from '../vault/mover.js';
import type { ContextualResult } from './hints.js';
import { getNode } from '../store/nodes.js';
import { countEdgesBySource, getEdgesBySource, countEdgesByTarget } from '../store/edges.js';

/**
 * `delete_note` — unlink a note from disk and purge it from the index.
 * The `confirm: true` literal is a Zod-level guard so the LLM can't call it
 * accidentally with a missing argument.
 *
 * When the delete removed inbound edges (`edgesRemoved > 0`), the response
 * wraps the plain delete result in a `{data, context: {next_actions}}`
 * envelope suggesting the caller rerun `rank_notes` with `minIncomingLinks:
 * 0` to surface freshly-orphaned notes. Bare callers that don't care can
 * ignore `context` — `data` has the same shape as the pre-envelope payload.
 */
export function registerDeleteNoteTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'delete_note',
    'Permanently delete a note. Removes the file from disk AND its index rows (edges, embedding, node). Requires `confirm: true` to guard against accidents. When the delete removes inbound edges, the response is wrapped in a next_actions envelope suggesting a follow-up `rank_notes(method=pagerank, minIncomingLinks=0)` to spot newly orphaned notes.',
    {
      name: z.string().describe('Path or fuzzy match of the note to delete.'),
      confirm: z.literal(true).describe('Must literally be `true` to execute. Guards against accidental deletion.'),
      dryRun: z.boolean().optional().describe('If true, report what would be deleted without removing any files.'),
    },
    async (args) => {
      const { name, dryRun } = args;

      const fileRelPath = resolveToSinglePath(name, ctx);

      if (dryRun === true) {
        // Preview what would be deleted without mutating anything.
        const node = getNode(ctx.db, fileRelPath);
        const edges = countEdgesBySource(ctx.db, fileRelPath);

        // Count stubs that would be pruned: outbound targets that are stubs
        // AND currently have exactly 1 inbound edge (which is from this note).
        const outbound = getEdgesBySource(ctx.db, fileRelPath);
        const stubsToPrune = outbound.filter(
          (e) => e.targetId.startsWith('_stub/') && countEdgesByTarget(ctx.db, e.targetId) === 1,
        ).length;

        return {
          dryRun: true,
          wouldDelete: {
            path: fileRelPath,
            node: node !== undefined,
            edges,
            stubsToPrune,
          },
        };
      }

      const result = await deleteNote(ctx.config.vaultPath, fileRelPath, ctx.db);

      let payload: DeleteResult | (DeleteResult & { reindex: string; reindexError: string }) = result;
      try {
        await ctx.ensureEmbedderReady();
        await ctx.pipeline.index(ctx.config.vaultPath);
      } catch (err) {
        payload = { ...result, reindex: 'failed', reindexError: String(err) };
      }

      const edgesRemoved = result.deletedFromIndex.edges;
      if (edgesRemoved > 0) {
        const envelope: ContextualResult<typeof payload> = {
          data: payload,
          context: {
            next_actions: [
              {
                description: 'Check for newly orphaned notes',
                tool: 'rank_notes',
                args: { metric: 'influence', minIncomingLinks: 0 },
                reason: `Removed ${edgesRemoved} edge${edgesRemoved === 1 ? '' : 's'} — some notes may now be orphans`,
              },
            ],
          },
        };
        return envelope;
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
