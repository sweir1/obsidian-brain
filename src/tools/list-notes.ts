import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { allNodeIds, getNode } from '../store/nodes.js';

export function registerListNotesTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'list_notes',
    'List notes in the vault. Optionally filter by directory prefix or by frontmatter tag. Pass `includeStubs: false` to exclude unresolved wiki-link targets (nodes with `frontmatter._stub: true`) and see only real on-disk notes.',
    {
      directory: z.string().optional().describe('Restrict to notes under this subdirectory prefix.'),
      tag: z.string().optional().describe('Restrict to notes containing this frontmatter tag.'),
      limit: z.number().int().positive().optional().describe('Max results to return. Default 100.'),
      includeStubs: z.boolean().optional().describe('Default `true`. Set `false` to exclude unresolved wiki-link targets.'),
    },
    async (args) => {
      const { directory, tag, limit, includeStubs } = args;
      const ids = allNodeIds(ctx.db);
      const results: Array<{
        id: string;
        title: string;
        tags: string[];
        frontmatter: Record<string, unknown>;
      }> = [];
      const cap = limit ?? 100;
      const excludeStubs = includeStubs === false;

      for (const id of ids) {
        if (directory !== undefined) {
          if (!(id.startsWith(directory + '/') || id === directory)) continue;
        }
        const node = getNode(ctx.db, id);
        if (!node) continue;
        if (excludeStubs && node.frontmatter._stub === true) continue;
        const tags = Array.isArray(node.frontmatter.tags)
          ? (node.frontmatter.tags as string[])
          : [];
        if (tag !== undefined && !tags.includes(tag)) continue;

        results.push({
          id: node.id,
          title: node.title,
          tags,
          frontmatter: node.frontmatter,
        });
        if (results.length >= cap) break;
      }

      return results;
    },
  );
}
