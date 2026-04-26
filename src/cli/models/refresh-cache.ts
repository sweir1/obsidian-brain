import type { Command } from 'commander';
import { clearMetadataCache } from '../../embeddings/metadata-cache.js';
import { openDb } from '../../store/db.js';
import { resolveDataConfig } from '../../config.js';
import { printJson } from './output.js';

export function registerRefreshCacheCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models refresh-cache
  //
  // v1.7.5: explicit invalidation for the metadata cache. The cache lives
  // forever once written (see metadata-cache.ts header for why); this is the
  // user-facing way to force a re-resolve from the seed → HF chain on next
  // server boot. Common uses: a model author fixed an upstream config and
  // you want the new value picked up; you switched providers and want
  // capacity / dim re-probed; debugging stale cached prefixes.
  // -------------------------------------------------------------------------
  parent
    .command('refresh-cache')
    .description(
      'Invalidate the metadata cache so the next server boot refetches ' +
      'from the seed → HF chain. Cheap for seeded models (~0 HF calls — the ' +
      'bundled seed repopulates the cache instantly); 1 HF call per ' +
      'non-seeded BYOM id. The prefix-strategy hash auto-detects any prefix ' +
      'change and triggers a re-embed in bootstrap, so it is safe to run any ' +
      'time you suspect cached metadata is stale. Restart the server after ' +
      'running this. Caveat: if you run it OFFLINE on a non-seeded BYOM id, ' +
      'fallback safe defaults get cached — fix by running again online or ' +
      'editing the override file (`models override`).',
    )
    .option('--model <id>', 'Refresh cache for one model id only (default: all entries)')
    .action((opts: { model?: string }) => {
      // Use resolveDataConfig (not resolveConfig) so this doesn't fail on
      // a missing VAULT_PATH. Cache invalidation is a vault-agnostic op
      // — it writes to the SQLite DB at the user's data dir, which is
      // derivable from XDG_DATA_HOME alone.
      const config = resolveDataConfig();
      const db = openDb(config.dbPath);
      try {
        const cleared = clearMetadataCache(db, opts.model);
        printJson({
          dbPath: config.dbPath,
          scope: opts.model ?? 'all',
          rowsCleared: cleared,
          nextBoot:
            'will refetch via metadata-resolver chain (cache miss → seed → live HF). ' +
            'Restart the server for the change to take effect.',
        });
      } finally {
        db.close();
      }
    });
}
