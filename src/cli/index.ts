#!/usr/bin/env node
import { Command } from 'commander';
import { createContext } from '../context.js';
import { startServer } from '../server.js';
import { dropEmbeddingState } from '../store/db.js';
import { startWatcher } from '../pipeline/watcher.js';
import { registerModelsCommands } from './models.js';

const program = new Command();
program
  .name('obsidian-brain')
  .description('Semantic search + knowledge graph + vault editing for Obsidian.')
  .version('1.2.2');

program
  .command('server')
  .description(
    'Start the stdio MCP server (spawned by Claude Desktop, Claude Code, Jan, etc.)',
  )
  .action(async () => {
    await startServer();
  });

program
  .command('index')
  .description('Scan the vault and update the knowledge-graph index (incremental)')
  .option('-r, --resolution <n>', 'Louvain resolution (passing this forces a community-cache refresh even if no files changed)', parseFloat)
  .option(
    '--drop',
    'Drop all embeddings + sync state before indexing. Required when switching EMBEDDING_MODEL to one with a different output dim.',
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
  .description('Semantic (default) or full-text search over the vault')
  .option('-l, --limit <n>', 'Max results', parseInt, 10)
  .option('-m, --mode <mode>', 'semantic | fulltext', 'semantic')
  .action(
    async (
      query: string,
      opts: { limit: number; mode: 'semantic' | 'fulltext' },
    ) => {
      const ctx = await createContext();
      let results;
      if (opts.mode === 'fulltext') {
        results = ctx.search.fulltext(query, opts.limit);
      } else {
        await ctx.ensureEmbedderReady();
        results = await ctx.search.semantic(query, opts.limit);
      }
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    },
  );

registerModelsCommands(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `CLI error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
