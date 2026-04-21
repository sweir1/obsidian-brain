import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { allNodeIds } from './store/nodes.js';

import { registerSearchTool } from './tools/search.js';
import { registerReadNoteTool } from './tools/read-note.js';
import { registerListNotesTool } from './tools/list-notes.js';
import { registerFindConnectionsTool } from './tools/find-connections.js';
import { registerFindPathBetweenTool } from './tools/find-path-between.js';
import { registerDetectThemesTool } from './tools/detect-themes.js';
import { registerRankNotesTool } from './tools/rank-notes.js';
import { registerCreateNoteTool } from './tools/create-note.js';
import { registerEditNoteTool } from './tools/edit-note.js';
import { registerLinkNotesTool } from './tools/link-notes.js';
import { registerMoveNoteTool } from './tools/move-note.js';
import { registerDeleteNoteTool } from './tools/delete-note.js';
import { registerReindexTool } from './tools/reindex.js';

export async function startServer(): Promise<void> {
  const ctx = await createContext();
  const server = new McpServer({ name: 'obsidian-brain', version: '1.0.0' });

  registerSearchTool(server, ctx);
  registerReadNoteTool(server, ctx);
  registerListNotesTool(server, ctx);
  registerFindConnectionsTool(server, ctx);
  registerFindPathBetweenTool(server, ctx);
  registerDetectThemesTool(server, ctx);
  registerRankNotesTool(server, ctx);
  registerCreateNoteTool(server, ctx);
  registerEditNoteTool(server, ctx);
  registerLinkNotesTool(server, ctx);
  registerMoveNoteTool(server, ctx);
  registerDeleteNoteTool(server, ctx);
  registerReindexTool(server, ctx);

  // Auto-index on first boot when the DB is empty. Blocks transport connect so
  // the first `tools/call` has data to work with. On a cold cache this also
  // downloads the ~22MB embedding model (one-time).
  if (allNodeIds(ctx.db).length === 0) {
    process.stderr.write(
      'obsidian-brain: index is empty, running first-time index. ' +
        'This may take 30-60s on first run (downloads embedding model).\n',
    );
    await ctx.ensureEmbedderReady();
    const stats = await ctx.pipeline.index(ctx.config.vaultPath);
    process.stderr.write(
      `obsidian-brain: indexed ${stats.nodesIndexed} notes, ` +
        `${stats.edgesIndexed} links, ${stats.communitiesDetected} communities.\n`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-run when invoked as a direct entry point (e.g. `node dist/server.js`).
// When imported by the CLI, this block is skipped.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    process.stderr.write(
      `obsidian-brain failed to start: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  });
}
