import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
import { allNodeIds } from './store/nodes.js';
import { startWatcher, type WatcherHandle } from './pipeline/watcher.js';

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
import { registerActiveNoteTool } from './tools/active-note.js';
import { registerDataviewQueryTool } from './tools/dataview-query.js';
import { registerBaseQueryTool } from './tools/base-query.js';

export async function startServer(): Promise<void> {
  const ctx = await createContext();
  const server = new McpServer({ name: 'obsidian-brain', version: pkg.version });

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
  registerActiveNoteTool(server, ctx);
  registerDataviewQueryTool(server, ctx);
  registerBaseQueryTool(server, ctx);

  const dbIsEmpty = allNodeIds(ctx.db).length === 0;

  // First-ever boot: block so the client doesn't hit tools/call against an
  // empty index. On a cold cache this also downloads the default embedding
  // model (~34MB for bge-small-en-v1.5, one-time). Subsequent boots skip
  // this path entirely.
  if (dbIsEmpty) {
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
  } else {
    // Non-empty DB: surface any bootstrap migration reasons (model change,
    // v1.4.0 chunk upgrade, FTS tokenizer swap) so users understand why a
    // reindex kicks in. The actual reindex is handled by the catchup path
    // below — forcing all sync mtimes to 0 so every note re-embeds under
    // the new model.
    await ctx.ensureEmbedderReady();
    const boot = ctx.getBootstrap();
    if (boot) {
      for (const reason of boot.reasons) {
        process.stderr.write(`obsidian-brain: ${reason}\n`);
      }
      if (boot.needsReindex) {
        // Force a from-scratch reindex by clearing sync mtimes — the indexer's
        // mtime-guard would otherwise skip every file.
        ctx.db.exec('DELETE FROM sync');
        process.stderr.write(
          'obsidian-brain: v1.4.0 upgrade: building per-chunk embeddings (may take a minute)...\n',
        );
      }
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Subsequent-boot catchup: the client has gone away and come back, and
  // notes may have been edited on disk in the meantime. Run an incremental
  // full-vault reindex in the background so the client gets `tools/list`
  // immediately; the watcher takes over for any live edits from here on.
  // Set OBSIDIAN_BRAIN_NO_CATCHUP=1 to disable.
  if (!dbIsEmpty && process.env.OBSIDIAN_BRAIN_NO_CATCHUP !== '1') {
    void (async () => {
      try {
        await ctx.ensureEmbedderReady();
        const stats = await ctx.pipeline.index(ctx.config.vaultPath);
        if (stats.nodesIndexed > 0) {
          process.stderr.write(
            `obsidian-brain: startup catchup — reindexed ${stats.nodesIndexed} ` +
              `notes modified while the server was down\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `obsidian-brain: startup catchup failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    })();
  }

  // Live reindex on vault changes. Set OBSIDIAN_BRAIN_NO_WATCH=1 to fall
  // back to the timer-driven model (periodic `obsidian-brain index` runs).
  let handle: WatcherHandle | null = null;
  if (process.env.OBSIDIAN_BRAIN_NO_WATCH !== '1') {
    handle = startWatcher(ctx, readWatcherOptsFromEnv());
  }

  const shutdown = async () => {
    if (handle) await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readWatcherOptsFromEnv() {
  const debounceMs = Number(process.env.OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS);
  const communityDebounceMs = Number(
    process.env.OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS,
  );
  return {
    debounceMs: Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : undefined,
    communityDebounceMs:
      Number.isFinite(communityDebounceMs) && communityDebounceMs > 0
        ? communityDebounceMs
        : undefined,
  };
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
