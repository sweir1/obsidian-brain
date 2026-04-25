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
import { EMBEDDING_PRESETS, type EmbeddingPresetName } from '../embeddings/presets.js';
import { prefetchModel } from '../embeddings/prefetch.js';
import { autoRecommendPreset } from '../embeddings/auto-recommend.js';
import { loadSeed } from '../embeddings/seed-loader.js';
import { getEmbeddingMetadata } from '../embeddings/hf-metadata.js';
import { clearMetadataCache } from '../embeddings/metadata-cache.js';
import { openDb } from '../store/db.js';
import { resolveConfig } from '../config.js';

// ---------------------------------------------------------------------------
// TTY-aware output helpers
// ---------------------------------------------------------------------------

/**
 * Print `obj` as structured JSON to stdout (always). When stdout is a TTY
 * also pretty-print a human-readable summary to stderr so piping still gets
 * clean JSON while interactive users get readable output.
 */
function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// registerModelsCommands
// ---------------------------------------------------------------------------

export function registerModelsCommands(program: Command): void {
  const models = program
    .command('models')
    .description('Inspect and manage embedding models');

  // -------------------------------------------------------------------------
  // models list
  // -------------------------------------------------------------------------
  models
    .command('list')
    .description('List all available embedding presets (zero network calls; reads bundled seed)')
    .action(() => {
      const isTTY = process.stdout.isTTY;
      const seed = loadSeed();

      const data = Object.entries(EMBEDDING_PRESETS).map(([name, p]) => {
        const meta = seed.get(p.model);
        return {
          preset: name,
          model: p.model,
          provider: p.provider,
          dim: meta?.dim ?? null,
          sizeMb: meta?.sizeBytes ? Math.round(meta.sizeBytes / 1024 / 1024) : null,
          symmetric: meta ? meta.queryPrefix === meta.documentPrefix : null,
        };
      });

      if (isTTY) {
        process.stderr.write('\nEmbedding presets:\n\n');
        const colW = [22, 38, 14, 6, 8, 10];
        const header = [
          'Preset'.padEnd(colW[0]),
          'Model'.padEnd(colW[1]),
          'Provider'.padEnd(colW[2]),
          'Dim'.padEnd(colW[3]),
          'SizeMb'.padEnd(colW[4]),
          'Symmetric',
        ].join('  ');
        process.stderr.write(header + '\n');
        process.stderr.write('-'.repeat(header.length) + '\n');
        for (const row of data) {
          process.stderr.write(
            [
              row.preset.padEnd(colW[0]),
              row.model.padEnd(colW[1]),
              row.provider.padEnd(colW[2]),
              String(row.dim ?? '?').padEnd(colW[3]),
              String(row.sizeMb ?? '?').padEnd(colW[4]),
              String(row.symmetric ?? '?'),
            ].join('  ') + '\n',
          );
        }
        process.stderr.write('\n');
      }

      printJson(data);
    });

  // -------------------------------------------------------------------------
  // models recommend
  // -------------------------------------------------------------------------
  models
    .command('recommend')
    .description(
      'Inspect the vault and recommend the best embedding preset. Reads VAULT_PATH from env.',
    )
    .action(async () => {
      const vaultPath = process.env.VAULT_PATH;
      if (!vaultPath) {
        process.stderr.write(
          'obsidian-brain: VAULT_PATH is not set. Cannot recommend a preset without a vault to inspect.\n',
        );
        process.exit(1);
      }

      const result = await autoRecommendPreset(process.env, vaultPath, undefined);

      if (result === null) {
        printJson({
          preset: null,
          reason: 'auto-recommend returned no result',
          skipped: true,
        });
        return;
      }

      if (result.skipped) {
        printJson({
          preset: result.preset,
          reason: result.reason,
          skipped: true,
        });
        return;
      }

      printJson({
        preset: result.preset,
        model: EMBEDDING_PRESETS[result.preset]?.model ?? null,
        reason: result.reason,
        skipped: false,
      });
    });

  // -------------------------------------------------------------------------
  // models prefetch [preset]
  // -------------------------------------------------------------------------
  models
    .command('prefetch [preset]')
    .description(
      'Warm the HF cache for a preset\'s model. Defaults to the "english" preset.',
    )
    .option('--timeout <ms>', 'Network timeout in ms', (v) => parseInt(v, 10), 60_000)
    .action(async (presetArg: string | undefined, opts: { timeout: number }) => {
      const presetName: EmbeddingPresetName =
        ((presetArg?.toLowerCase().trim() ?? 'english') as EmbeddingPresetName);

      const preset = EMBEDDING_PRESETS[presetName];
      if (!preset) {
        const valid = Object.keys(EMBEDDING_PRESETS).join(', ');
        process.stderr.write(
          `obsidian-brain: unknown preset "${presetArg}". Valid presets: ${valid}\n`,
        );
        process.exit(1);
      }

      const modelId = preset.model;
      const started = Date.now();

      process.stderr.write(
        `obsidian-brain: prefetching model "${modelId}" (preset: ${presetName})…\n`,
      );

      const result = await prefetchModel(modelId, {
        backoffBaseMs: 1000,
      });

      const durationMs = Date.now() - started;
      void opts.timeout;

      printJson({
        model: result.model,
        dim: result.dim,
        cachedAt: result.cachedAt,
        durationMs,
      });
    });

  // -------------------------------------------------------------------------
  // models check <id>
  // -------------------------------------------------------------------------
  models
    .command('check <id>')
    .description(
      'Fetch model metadata from HF without downloading the model (~1s). ' +
      'Add --load to also download + load via transformers.js (~30s).',
    )
    .option('--timeout <ms>', 'HTTP timeout in ms', (v) => parseInt(v, 10), 10_000)
    .option('--load', 'Also download + load the model (slow)', false)
    .action(async (id: string, opts: { timeout: number; load: boolean }) => {
      const timeoutMs = opts.timeout ?? 10_000;

      process.stderr.write(`obsidian-brain: checking model "${id}"…\n`);

      // v1.7.5: metadata-only path. No model download. Single HF API round-trip.
      let meta;
      try {
        meta = await getEmbeddingMetadata(id, { timeoutMs });
      } catch (err) {
        process.stderr.write(
          `obsidian-brain: model check failed: ${(err as Error)?.message ?? String(err)}\n`,
        );
        process.exit(1);
      }

      const result: Record<string, unknown> = {
        model: meta.modelId,
        modelType: meta.modelType,
        dim: meta.dim,
        advertisedMaxTokens: meta.maxTokens,
        symmetric: meta.queryPrefix === meta.documentPrefix,
        queryPrefix: meta.queryPrefix,
        documentPrefix: meta.documentPrefix,
        prefixSource: meta.prefixSource,
        baseModel: meta.baseModel,
        sizeMb: meta.sizeBytes !== null ? Math.round(meta.sizeBytes / 1024 / 1024) : null,
        ready: true,
      };

      // Optional: download + load the actual model for end-to-end validation.
      if (opts.load) {
        process.stderr.write('obsidian-brain: --load set — downloading + loading the model…\n');
        try {
          const loaded = await prefetchModel(id, { backoffBaseMs: 1000 });
          result.loadedDim = loaded.dim;
          result.cachedAt = loaded.cachedAt;
        } catch (err) {
          process.stderr.write(
            `obsidian-brain: model load failed: ${(err as Error)?.message ?? String(err)}\n`,
          );
          process.exit(1);
        }
      }

      printJson(result);
    });

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
  models
    .command('refresh-cache')
    .description(
      'Invalidate the v1.7.5 metadata cache so the next server boot refetches ' +
      'from the seed → HF chain. Restart the server after running this.',
    )
    .option('--model <id>', 'Refresh cache for one model id only (default: all entries)')
    .action((opts: { model?: string }) => {
      const config = resolveConfig({});
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
