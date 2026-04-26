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
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { createContext } from '../context.js';
import { startServer } from '../server.js';
import { debugLog } from '../util/debug-log.js';
import { dropEmbeddingState } from '../store/db.js';
import { startWatcher } from '../pipeline/watcher.js';
import { registerModelsCommands } from './models.js';
import { UserError, formatUserError } from '../errors.js';

debugLog('module-load: src/cli/index.ts (all imports complete)');

// Read the published version from package.json at runtime so `--version`
// always tracks the npm-published release. Pre-v1.7.5 this was hardcoded
// at '1.2.2' and silently drifted across every release. The relative path
// `../../package.json` resolves the same way both at dev-time
// (`src/cli/index.ts → src/../package.json`, after tsc emits to
// `dist/cli/index.js → dist/cli/../../package.json`) and inside the
// installed npm tarball (`<root>/dist/cli/index.js → <root>/package.json`).
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
debugLog(`cli: package.json read OK (version=${pkg.version})`);

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
    'Drop all embeddings + sync state before indexing. Mostly an escape hatch — the bootstrap auto-detects EMBEDDING_MODEL / EMBEDDING_PROVIDER changes and wipes embedding state on its own; `--drop` is for forcing a from-scratch rebuild when something else has gone wrong.',
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
// when imported by tests.
//
// **v1.7.14 fix:** the naive `process.argv[1] === fileURLToPath(import.meta.url)`
// idiom has a structural symlink trap. npx invokes node via the
// `.bin/obsidian-brain` symlink, so `process.argv[1]` is the symlink
// path verbatim. But Node's ESM loader resolves symlinks during
// module-graph evaluation by default, so `import.meta.url` is the URL
// of the real file — and `fileURLToPath` returns the resolved path.
// One side resolved, the other not → strict equality fails under
// EVERY symlinked invocation (npx, pnpm bin, yarn-link, manual
// symlinks). Process exits cleanly with code 0; Claude Desktop sees
// stdio EOF and reports "transport closed unexpectedly" with no
// error in the log. v1.7.13's debug trace empirically proved this.
//
// Fix: realpathSync both sides so symlinks normalize to the same target
// before comparing. Wrapped in try/catch with a raw-comparison fallback
// so we never make pathological cases worse.
function isMainEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) {
    debugLog('isMainEntry: argv[1] unset → false');
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const argvReal = realpathSync(argv1);
    const moduleReal = realpathSync(modulePath);
    const match = argvReal === moduleReal;
    debugLog(
      `isMainEntry: argv-real="${argvReal}" module-real="${moduleReal}" match=${match}`,
    );
    return match;
  } catch (err) {
    /* v8 ignore start -- defensive fallback, only fires when realpath ENOENTs */
    debugLog(
      `isMainEntry: realpathSync threw, falling back to raw compare — ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return argv1 === modulePath;
    /* v8 ignore stop */
  }
}

const _argv1 = process.argv[1] ?? '<unset>';
const _moduleUrl = import.meta.url;
const _modulePath = fileURLToPath(import.meta.url);
debugLog(`cli: about to check main-entry — argv[1]="${_argv1}" import.meta.url="${_moduleUrl}" fileURLToPath="${_modulePath}"`);
if (isMainEntry()) {
  debugLog(`cli: main-entry check PASSED — entry point reached, argv = ${JSON.stringify(process.argv.slice(2))}`);
  debugLog('cli: building program + invoking parseAsync');
  buildProgram()
    .parseAsync(process.argv)
    .then((cmd) => {
      debugLog('cli: parseAsync resolved cleanly (subcommand handler returned)');
      return cmd;
    })
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
} else {
  // After the v1.7.14 realpath fix, this branch should ONLY fire when the
  // module is imported by tests (e.g. vitest worker — argv[1] is the
  // worker's entrypoint, not cli/index.ts; both realpath fine but to
  // different paths, so the check correctly says "not main entry").
  // If you see this in a CLI invocation log, something else is wrong:
  // case-insensitive filesystem with mixed-case paths, --preserve-symlinks
  // breaking ESM resolution, or a brand-new edge case worth filing.
  debugLog(
    `cli: main-entry check FAILED — process will exit cleanly when event loop drains. ` +
    `argv[1]="${_argv1}" fileURLToPath="${_modulePath}" — these don't match after realpath. ` +
    `Expected when imported by tests; unexpected for a CLI invocation. Server will not start.`,
  );
}
