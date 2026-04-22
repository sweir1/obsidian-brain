import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { getNode } from '../store/nodes.js';
import {
  getEdgeSummariesBySource,
  getEdgeSummariesByTarget,
  getEdgesBySource,
  getEdgesByTarget,
} from '../store/edges.js';
import { computeReadNoteHints } from './hints.js';

export function registerReadNoteTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'read_note',
    "Read a note's content. Brief mode (default) returns title + metadata + linked-note titles; full mode returns full content + edge context. Full mode also reports `truncated: true` when the body exceeded `maxContentLength` (default 2000 chars) and was sliced. Response is wrapped as `{data, context}` where `context.next_actions` suggests follow-ups like creating missing linked notes or exploring outgoing connections.",
    {
      name: z.string(),
      mode: z.enum(['brief', 'full']).optional(),
      maxContentLength: z.number().int().positive().optional(),
    },
    async (args) => {
      const { name, mode, maxContentLength } = args;
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

      const id = first.nodeId;
      const node = getNode(ctx.db, id);
      if (!node) throw new Error(`No note found matching "${name}"`);

      const mode_ = mode ?? 'brief';
      if (mode_ === 'brief') {
        const outgoingSummaries = getEdgeSummariesBySource(ctx.db, id);
        const incomingSummaries = getEdgeSummariesByTarget(ctx.db, id);
        const outgoing = outgoingSummaries.map((e) => ({
          targetId: e.nodeId,
          targetTitle: e.title,
        }));
        const incoming = incomingSummaries.map((e) => ({
          sourceId: e.nodeId,
          sourceTitle: e.title,
        }));
        const unresolvedLinks = outgoingSummaries
          .filter((e) => getNode(ctx.db, e.nodeId) === undefined)
          .map((e) => e.nodeId);
        const data = {
          id: node.id,
          title: node.title,
          frontmatter: node.frontmatter,
          outgoing,
          incoming,
        };
        const context = computeReadNoteHints({
          id: node.id,
          outgoing: outgoing.map((o) => o.targetId),
          unresolvedLinks,
        });
        return { data, context };
      }

      const max = maxContentLength ?? 2000;
      const truncated = node.content.length > max;
      const content = truncated ? node.content.slice(0, max) : node.content;
      const outgoingEdges = getEdgesBySource(ctx.db, id);
      const incomingEdges = getEdgesByTarget(ctx.db, id);
      const outgoing = outgoingEdges.map((e) => {
        const target = getNode(ctx.db, e.targetId);
        return {
          targetId: e.targetId,
          targetTitle: target?.title ?? e.targetId,
          context: e.context,
        };
      });
      const incoming = incomingEdges.map((e) => {
        const source = getNode(ctx.db, e.sourceId);
        return {
          sourceId: e.sourceId,
          sourceTitle: source?.title ?? e.sourceId,
          context: e.context,
        };
      });
      const unresolvedLinks = Array.from(
        new Set(
          outgoingEdges
            .filter((e) => getNode(ctx.db, e.targetId) === undefined)
            .map((e) => e.targetId),
        ),
      );
      const data = {
        id: node.id,
        title: node.title,
        frontmatter: node.frontmatter,
        content,
        truncated,
        outgoing,
        incoming,
      };
      const context = computeReadNoteHints({
        id: node.id,
        outgoing: Array.from(new Set(outgoing.map((o) => o.targetId))),
        unresolvedLinks,
      });
      return { data, context };
    },
  );
}
