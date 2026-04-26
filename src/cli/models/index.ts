/**
 * `obsidian-brain models` subcommand group.
 *
 * Subcommands:
 *   models list                       — print EMBEDDING_PRESETS as JSON (structured)
 *   models recommend                  — inspect vault, suggest best preset
 *   models prefetch [preset]          — warm the HF cache for a preset's model
 *   models check <id>                 — fetch model metadata via HF API (no download).
 *                                       Add --load to also download + load the model.
 *   models refresh-cache [--model id] — invalidate the v1.7.5 metadata cache.
 *
 * Register via `registerModelsCommands(program)` after the top-level
 * commands in src/cli/index.ts.
 *
 * v1.7.5: dropped `KNOWN_MAX_TOKENS` lookup and `deriveSymmetric` heuristic
 * — both are now derived from the bundled seed (`data/seed-models.json`)
 * or live HF metadata fetch (`getEmbeddingMetadata`). `models check` no
 * longer downloads the model unless `--load` is set; the metadata-only path
 * runs in <2s vs the prior ~30s download-and-load.
 */

import type { Command } from 'commander';
import { debugLog } from '../../util/debug-log.js';
import { registerListCommand } from './list.js';
import { registerRecommendCommand } from './recommend.js';
import { registerPrefetchCommand } from './prefetch.js';
import { registerCheckCommand } from './check.js';
import { registerRefreshCacheCommand } from './refresh-cache.js';
import { registerAddCommand } from './add.js';
import { registerOverrideCommand } from './override.js';
import { registerFetchSeedCommand } from './fetch-seed.js';

debugLog('module-load: src/cli/models/index.ts');

export function registerModelsCommands(program: Command): void {
  const models = program
    .command('models')
    .description('Inspect and manage embedding models');

  registerListCommand(models);
  registerRecommendCommand(models);
  registerPrefetchCommand(models);
  registerCheckCommand(models);
  registerRefreshCacheCommand(models);
  registerAddCommand(models);
  registerOverrideCommand(models);
  registerFetchSeedCommand(models);
}
