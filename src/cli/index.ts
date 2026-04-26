#!/usr/bin/env node
// MUST be the first import. Preflight loads native modules
// (better-sqlite3, sqlite-vec) inside try/catch via createRequire so an
// ABI / dlopen failure surfaces a synchronous error to fd 2 + a
// crash-log file at ~/.cache/obsidian-brain/last-startup-error.log
// instead of dying silently before any error handler is on the stack.
// See src/preflight.ts header for the full rationale.
import '../preflight.js';

// MUST be the second import — armed before any user code so
// uncaughtException / unhandledRejection events are caught with synchronous
// stderr writes + crash-log instead of Node's default async-stderr-then-exit
// race (the silent-crash class fixed in v1.7.11). See src/global-handlers.ts.
import '../global-handlers.js';

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { createContext } from '../context.js';
import { startServer } from '../server.js';
import { debugLog } from '../util/debug-log.js';
import { dropEmbeddingState } from '../store/db.js';
import { startWatcher } from '../pipeline/watcher.js';
import { registerModelsCommands } from './models.js';
import { UserError, formatUserError } from '../errors.js';

// Read the published version from package.json at runtime so `--version`
// always tracks the npm-published release. Pre-v1.7.5 this was hardcoded
// at '1.2.2' and silently drifted across every release. The relative path
// `../../package.json` resolves the same way both at dev-time
// (`src/cli/index.ts → src/../package.json`, after tsc emits to
// `dist/cli/index.js → dist/cli/../../package.json`) and inside the
// installed npm tarball (`<root>/dist/cli/index.js → <root>/package.json`).
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/**
 * Build the Commander `program` with every subcommand registered. Exposed
 * (rather than only constructed inline) so test/cli/help-snapshot.test.ts
 * can import it and snapshot the help-text output of every subcommand
 * without needing to spawn a child process.
 *
 * The script entry-point at the bottom of this file is gated behind a
 * `process.argv[1] === fileURLToPath(import.meta.url)` check so importing
 * this module from a test never accidentally triggers `parseAsync`.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
  .name('obsidian-brain')
  .description('Semantic search + knowledge graph + vault editing for Obsidian.')
  // Override Commander's default short flag from `-V` (capital) to `-v`
  // (lowercase) — that's what every other modern CLI uses (`node -v`,
  // `npm -v`, `git --version` doesn't have a short, `gh --version` doesn't,
  // but lowercase `-v` is the convention everywhere it exists). Commander
  // only allows ONE short flag per option, so we drop `-V` to keep the
  // expected one. `-h` / `--help` keep Commander's defaults.
  .version(pkg.version, '-v, --version');

program
  .command('server')
  .description(
    'Start the stdio MCP server (spawned by Claude Desktop, Claude Code, Jan, etc.)',
  )
  .action(async () => {
    debugLog("cli: 'server' subcommand action entered, calling startServer()");
    await startServer();
    debugLog('cli: startServer() returned (server is now running, awaiting transport messages)');
  });

program
  .command('index')
  .description('Scan the vault and update the knowledge-graph index (incremental)')
  .option('-r, --resolution <n>', 'Louvain resolution (passing this forces a community-cache refresh even if no files changed)', parseFloat)
  .option(
    '--drop',
    'Drop all embeddings + sync state before indexing. Mostly an escape hatch — since v1.4.0 the bootstrap auto-detects EMBEDDING_MODEL / EMBEDDING_PROVIDER changes and wipes embedding state on its own; `--drop` is for forcing a from-scratch rebuild when something else has gone wrong.',
    false,
  )
  .action(async (opts: { resolution?: number; drop: boolean }) => {
    const ctx = await createContext();
    if (opts.drop) {
      dropEmbeddingState(ctx.db);
      process.stderr.write(
        'obsidian-brain: dropped existing embeddings + sync state\n',
      );
    }
    await ctx.ensureEmbedderReady();
    const stats = await ctx.pipeline.index(ctx.config.vaultPath, opts.resolution);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  });

program
  .command('watch')
  .description(
    'Long-running process: keep the index live by reindexing on vault changes. Use this if you want to run the watcher independently from an MCP client (via launchd/systemd).',
  )
  .option('--debounce <ms>', 'Per-file reindex debounce (ms)', (v) => parseInt(v, 10), 3000)
  .option(
    '--community-debounce <ms>',
    'Graph-wide community detection debounce (ms)',
    (v) => parseInt(v, 10),
    60000,
  )
  .action(
    async (opts: { debounce: number; communityDebounce: number }) => {
      const ctx = await createContext();
      await ctx.ensureEmbedderReady();
      const handle = startWatcher(ctx, {
        debounceMs: opts.debounce,
        communityDebounceMs: opts.communityDebounce,
      });
      let shuttingDown = false;
      const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stderr.write(`obsidian-brain: shutting down (${reason}).\n`);
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.stdin.on('end', () => void shutdown('stdin EOF'));
      process.stdin.on('close', () => void shutdown('stdin closed'));
      await new Promise<void>(() => {}); // hold process open
    },
  );

program
  .command('search <query>')
  .description('Hybrid (default), semantic, or full-text search over the vault')
  .option('-l, --limit <n>', 'Max results', parseInt, 10)
  .option(
    '-m, --mode <mode>',
    'hybrid (RRF-fused, the production default) | semantic | fulltext',
    'hybrid',
  )
  .action(
    async (
      query: string,
      opts: { limit: number; mode: 'hybrid' | 'semantic' | 'fulltext' },
    ) => {
      const ctx = await createContext();
      let results;
      if (opts.mode === 'fulltext') {
        results = ctx.search.fulltext(query, opts.limit);
      } else if (opts.mode === 'semantic') {
        await ctx.ensureEmbedderReady();
        results = await ctx.search.semantic(query, opts.limit);
      } else if (opts.mode === 'hybrid') {
        await ctx.ensureEmbedderReady();
        results = await ctx.search.hybrid(query, opts.limit);
      } else {
        process.stderr.write(
          `obsidian-brain: unknown --mode '${opts.mode}'. Valid: hybrid, semantic, fulltext.\n`,
        );
        process.exit(1);
      }
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    },
  );

  registerModelsCommands(program);
  return program;
}

// Script entry-point: only fires when the file is executed directly (e.g.
// via the `obsidian-brain` bin shim or `node dist/cli/index.js …`), NOT
// when imported by tests. The check compares `process.argv[1]` (the script
// node was launched with) against this module's own URL → path. They match
// in production; differ when imported from a vitest worker.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  debugLog(`cli: entry point reached, argv = ${JSON.stringify(process.argv.slice(2))}`);
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      // UserError = expected user-facing problem (missing env var, bad
      // flag value, etc.). Print the message + optional hint, no stack
      // trace. Programmer / internal errors keep printing the full stack
      // so bugs remain debuggable.
      // Synchronous fs.writeSync(2, …) instead of process.stderr.write so
      // the bytes reach the OS pipe before process.exit(1) can race with
      // Node's async stderr buffer. Same rationale as src/server.ts and
      // src/preflight.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const writeSync = (msg: string): void => {
        try { require('node:fs').writeSync(2, msg); }
        catch { process.stderr.write(msg); }
      };
      if (err instanceof UserError) {
        writeSync(formatUserError(err));
        process.exit(1);
      }
      writeSync(
        `CLI error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
