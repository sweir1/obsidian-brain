import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { debugLog } from './util/debug-log.js';

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
import { registerApplyEditPreviewTool } from './tools/apply-edit-preview.js';
import { registerLinkNotesTool } from './tools/link-notes.js';
import { registerMoveNoteTool } from './tools/move-note.js';
import { registerDeleteNoteTool } from './tools/delete-note.js';
import { registerReindexTool } from './tools/reindex.js';
import { registerActiveNoteTool } from './tools/active-note.js';
import { registerDataviewQueryTool } from './tools/dataview-query.js';
import { registerBaseQueryTool } from './tools/base-query.js';
import { registerIndexStatusTool } from './tools/index-status.js';

export async function startServer(): Promise<void> {
  debugLog('startServer: entry, awaiting createContext');
  const ctx = await createContext();
  debugLog('startServer: createContext returned, instantiating McpServer');
  const server = new McpServer({ name: 'obsidian-brain', version: pkg.version });
  debugLog('startServer: McpServer instantiated, registering 18 tools');

  registerSearchTool(server, ctx);
  registerReadNoteTool(server, ctx);
  registerListNotesTool(server, ctx);
  registerFindConnectionsTool(server, ctx);
  registerFindPathBetweenTool(server, ctx);
  registerDetectThemesTool(server, ctx);
  registerRankNotesTool(server, ctx);
  registerCreateNoteTool(server, ctx);
  registerEditNoteTool(server, ctx);
  registerApplyEditPreviewTool(server, ctx);
  registerLinkNotesTool(server, ctx);
  registerMoveNoteTool(server, ctx);
  registerDeleteNoteTool(server, ctx);
  registerReindexTool(server, ctx);
  registerActiveNoteTool(server, ctx);
  registerDataviewQueryTool(server, ctx);
  registerBaseQueryTool(server, ctx);
  registerIndexStatusTool(server, ctx);
  debugLog('startServer: all 18 tools registered, querying allNodeIds for boot-state decision');

  const dbIsEmpty = allNodeIds(ctx.db).length === 0;
  debugLog(`startServer: dbIsEmpty=${dbIsEmpty}, instantiating StdioServerTransport`);

  // Connect to the MCP transport immediately so the initialize handshake
  // completes in <100ms regardless of whether the embedding model has been
  // downloaded. Model download + first-time index proceed in the background.
  const transport = new StdioServerTransport();
  debugLog('startServer: calling server.connect(transport) — handshake will fire next');
  await server.connect(transport);
  debugLog('startServer: server.connect returned — transport is live, scheduling background block');

  // Background init: embedder download, bootstrap, and initial index all run
  // asynchronously after the handshake. ctx.embedderReady() exposes the state
  // to tool handlers; ctx.initError captures any failure for tools to surface.
  void (async () => {
    debugLog('background: entered fire-and-forget init block');
    try {
      if (dbIsEmpty) {
        debugLog('background: dbIsEmpty branch — first-boot, calling ensureEmbedderReady');
        // First-ever boot: download model and build initial index.
        process.stderr.write(
          'obsidian-brain: index is empty, running first-time index. ' +
            'This may take 30-60s on first run (downloads embedding model).\n',
        );
        await ctx.ensureEmbedderReady();
        ctx.enqueueBackgroundReindex(async () => {
          const stats = await ctx.pipeline.index(ctx.config.vaultPath);
          process.stderr.write(
            `obsidian-brain: indexed ${stats.nodesIndexed} notes, ` +
              `${stats.edgesIndexed} links, ${stats.communitiesDetected} communities.\n`,
          );
        });
      } else {
        // Non-empty DB: surface any bootstrap migration reasons (model change,
        // v1.4.0 chunk upgrade, FTS tokenizer swap) so users understand why a
        // reindex kicks in. The actual reindex is handled by the catchup path
        // below — forcing all sync mtimes to 0 so every note re-embeds under
        // the new model.
        debugLog('background: non-empty DB branch — calling ensureEmbedderReady');
        await ctx.ensureEmbedderReady();
        debugLog('background: ensureEmbedderReady complete, calling getBootstrap');
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

        // Subsequent-boot catchup: the client has gone away and come back, and
        // notes may have been edited on disk in the meantime. Run an incremental
        // full-vault reindex in the background so the client gets `tools/list`
        // immediately; the watcher takes over for any live edits from here on.
        // Set OBSIDIAN_BRAIN_NO_CATCHUP=1 to disable.
        if (process.env.OBSIDIAN_BRAIN_NO_CATCHUP !== '1') {
          ctx.enqueueBackgroundReindex(async () => {
            const stats = await ctx.pipeline.index(ctx.config.vaultPath);
            if (stats.nodesIndexed > 0) {
              process.stderr.write(
                `obsidian-brain: startup catchup — reindexed ${stats.nodesIndexed} ` +
                  `notes modified while the server was down\n`,
              );
            }
          });
        }
      }
      debugLog('background: init block completed without errors');
    } catch (err) {
      ctx.initError = err;
      process.stderr.write(`obsidian-brain: background init failed: ${err}\n`);
      debugLog(`background: init block CAUGHT error — ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  debugLog('startServer: background block scheduled, starting watcher');

  // Live reindex on vault changes. Set OBSIDIAN_BRAIN_NO_WATCH=1 to fall
  // back to the timer-driven model (periodic `obsidian-brain index` runs).
  let handle: WatcherHandle | null = null;
  if (process.env.OBSIDIAN_BRAIN_NO_WATCH !== '1') {
    handle = startWatcher(ctx, readWatcherOptsFromEnv());
    debugLog('startServer: watcher started');
  } else {
    debugLog('startServer: watcher SKIPPED (OBSIDIAN_BRAIN_NO_WATCH=1)');
  }

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    debugLog(`shutdown: invoked with reason="${reason}", shuttingDown=${shuttingDown}`);
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`obsidian-brain: shutting down (${reason}).\n`);
    // Order matters: stop the watcher (drains in-flight indexer work) → release
    // ONNX Runtime's thread pool (primary source of `libc++abi: mutex lock
    // failed` at exit) → close the SQLite handle (flush WAL, release fd). A
    // try/catch swallows teardown errors because we're already exiting; a
    // throw here would skip the fallback timer below and risk hanging.
    try {
      if (handle) {
        debugLog('shutdown: closing watcher');
        await handle.close();
        debugLog('shutdown: watcher closed');
      }
      if (ctx.embedderReady()) {
        debugLog('shutdown: disposing embedder (ONNX runtime threads)');
        await ctx.embedder.dispose();
        debugLog('shutdown: embedder disposed');
      }
      debugLog('shutdown: closing DB');
      ctx.db.close();
      debugLog('shutdown: DB closed');
    } catch (err) {
      process.stderr.write(`obsidian-brain: teardown error (ignored): ${err}\n`);
      debugLog(`shutdown: teardown caught error — ${err instanceof Error ? err.message : String(err)}`);
    }
    // Prefer natural event-loop drain (timers are already .unref()'d) so
    // native threads have a chance to release. Fall back to a hard exit at
    // 4s in case something refuses to quiesce.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 4_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  debugLog('startServer: SIGINT/SIGTERM handlers registered');

  // Session-end: the MCP SDK fires `transport.onclose` when the client ends
  // the JSON-RPC session cleanly. Wire our shutdown to it so we don't linger
  // after a normal disconnect.
  transport.onclose = () => void shutdown('MCP transport closed');

  // Orphan watcher: if the host process (Claude Desktop, Jan, Codex, Cursor,
  // VS Code) crashes or is force-quit without sending SIGTERM, this process
  // would otherwise keep running forever under launchd / init. We probe the
  // original parent PID once a minute with signal 0 (pure existence check,
  // no side effect). Works cross-platform — on macOS/Linux the OS reparents
  // us to PID 1 so the dead original PID trips the check; on Windows PPID
  // doesn't change on orphaning but signal 0 still throws ESRCH when the
  // original parent is gone. `.unref()` keeps the interval from pinning the
  // event loop when nothing else is alive.
  //
  // Previously we listened on `process.stdin` `end` / `close`, but that
  // false-fires under Jan: Jan closes stdin briefly between initialize and
  // the first tools/list while loading its local LLM, which would trigger
  // an immediate self-exit here.
  const originalPpid = process.ppid;
  setInterval(() => {
    try {
      process.kill(originalPpid, 0);
    } catch {
      void shutdown('parent process died (orphaned)');
    }
  }, 60_000).unref();
  debugLog(`startServer: orphan-PPID watchdog armed (parent PID=${originalPpid})`);
  debugLog('startServer: all wiring complete, function returning — server is now live');
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
    // Synchronous fs.writeSync(2, …) instead of process.stderr.write —
    // process.exit(1) doesn't wait for Node's async stderr buffer to drain,
    // and a crash before the buffer flushes lands in Claude Desktop's pipe
    // as EOF with no error visible. writeSync blocks on the OS write()
    // syscall directly, so the bytes always reach the pipe before exit.
    const msg = `obsidian-brain failed to start: ${
      err instanceof Error ? err.stack ?? err.message : String(err)
    }\n`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeSync(2, msg);
    } catch {
      // Fall back to async if writeSync is unavailable for any reason —
      // not ideal but better than nothing.
      process.stderr.write(msg);
    }
    process.exit(1);
  });
}
