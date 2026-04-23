/**
 * Simple real-embedder ServerContext builder + teardown for graph-integration
 * tests. Unlike init-timing-ctx, this variant assumes the embedder is fully
 * ready; no init state to simulate.
 *
 * cleanupCtx drains the pending fire-and-forget reindex before removing the
 * vault so a late reindex doesn't race with rmSync and log ENOENT.
 */

import { rmSync } from 'node:fs';
import type { Embedder } from '../../src/embeddings/embedder.js';
import type { IndexPipeline } from '../../src/pipeline/indexer.js';
import { VaultWriter } from '../../src/vault/writer.js';
import type { DatabaseHandle } from '../../src/store/db.js';
import type { ServerContext } from '../../src/context.js';

export function buildSimpleCtx(
  vault: string,
  db: DatabaseHandle,
  pipeline: IndexPipeline,
  embedder: Embedder,
): ServerContext {
  const writer = new VaultWriter(vault, db);
  const ctx = {
    db,
    embedder,
    pipeline,
    writer,
    config: { vaultPath: vault },
    ensureEmbedderReady: async () => {},
    embedderReady: () => true,
    initError: undefined,
    pendingReindex: Promise.resolve(),
    enqueueBackgroundReindex(work: () => Promise<void>): void {
      ctx.pendingReindex = ctx.pendingReindex.finally(() => {
        return work().catch((err: unknown) => {
          process.stderr.write(
            `obsidian-brain: background reindex failed: ${String(err)}\n`,
          );
        });
      });
    },
  };
  return ctx as unknown as ServerContext;
}

/**
 * Drain any queued background reindex, then remove the vault and close the DB.
 * Call from the end of each integration test so the fire-and-forget reindex
 * can't race with vault teardown and spam ENOENT into stderr.
 */
export async function cleanupCtx(
  ctx: ServerContext,
  vault: string,
  db: DatabaseHandle,
): Promise<void> {
  await ctx.pendingReindex;
  rmSync(vault, { recursive: true, force: true });
  db.close();
}
