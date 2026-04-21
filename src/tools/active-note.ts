import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';

export function registerActiveNoteTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'active_note',
    'Return the note currently open in Obsidian, including cursor position and selection. Requires the obsidian-brain companion plugin installed and Obsidian running against the same vault.',
    {},
    async () => {
      return ctx.obsidian.active();
    },
  );
}
