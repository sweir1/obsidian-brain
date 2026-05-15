import type { ServerContext } from '../context.js';
import { logger } from '../util/logger.js';

/**
 * Shared fire-and-forget reindex helper used by every write tool
 * (create_note, edit_note, apply_edit_preview, move_note, delete_note,
 * link_notes). The write has already landed on disk by the time this runs;
 * the reindex just brings the DB into eventual consistency.
 *
 * Routes through `ctx.enqueueBackgroundReindex` when the full production
 * context provides it (so tests can `await ctx.pendingReindex` before
 * teardown to avoid ENOENT on reindex-after-rmdir races). Falls back to a
 * bare `void`-chained promise for lean test stubs that don't wire up the
 * queue. Both paths log failures to stderr and never throw.
 */
export function runBackgroundReindex(ctx: ServerContext): void {
  const work = async (): Promise<void> => {
    await ctx.ensureEmbedderReady();
    await ctx.pipeline.index(ctx.config.vaultPath);
  };

  if (typeof ctx.enqueueBackgroundReindex === 'function') {
    ctx.enqueueBackgroundReindex(work);
    return;
  }

  // Fallback for minimal test stubs (and any future consumer that builds
  // its own context without the queue hook).
  void work().catch((err: unknown) => {
    logger.error(`background reindex failed: ${String(err)}`, { error: String(err) });
  });
}
