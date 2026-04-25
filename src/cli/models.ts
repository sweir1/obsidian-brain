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
  // models list [--all] [--filter <substr>]
  //
  // Default: 6 hardcoded presets (the curated user-friendly defaults).
  // --all: surface every entry in the bundled seed (348 models from MTEB's
  //        Python registry as of mteb 2.12.30) — useful for BYOM users
  //        wanting to know which ids get instant first-boot vs which
  //        will trigger a live HF fetch on first use.
  // --filter <q>: substring match (case-insensitive) on model id. Combines
  //               with --all to e.g. `models list --all --filter e5` to
  //               see every E5 variant in the seed.
  // -------------------------------------------------------------------------
  models
    .command('list')
    .description(
      'List embedding models. By default shows the 6 hardcoded presets; ' +
      'pass --all to surface every entry in the bundled MTEB-derived seed ' +
      '(~348 models). --filter narrows by substring on model id.',
    )
    .option('--all', 'Include every model in the bundled seed, not just the 6 presets', false)
    .option('--filter <substr>', 'Case-insensitive substring filter on model id')
    .action((opts: { all: boolean; filter?: string }) => {
      const isTTY = process.stdout.isTTY;
      const seed = loadSeed();
      const filter = opts.filter?.toLowerCase().trim();

      // Build a lookup of presets keyed by model id so seed entries can
      // be cross-referenced (a seed model that happens to be a preset
      // gets its preset name attached in the output).
      const presetByModel = new Map<string, { preset: string; provider: string }>();
      for (const [name, p] of Object.entries(EMBEDDING_PRESETS)) {
        presetByModel.set(p.model, { preset: name, provider: p.provider });
      }

      // Collect rows. Always include all 6 presets first (even if a
      // preset's model is NOT in the seed — surface them so the user
      // sees the curated set unconditionally). When --all, also include
      // every other seed entry alphabetically.
      type Row = {
        preset: string | null;
        model: string;
        provider: string;
        maxTokens: number | null;
        symmetric: boolean | null;
      };

      const rows: Row[] = [];
      const seenModels = new Set<string>();

      for (const [name, p] of Object.entries(EMBEDDING_PRESETS)) {
        const meta = seed.get(p.model);
        rows.push({
          preset: name,
          model: p.model,
          provider: p.provider,
          maxTokens: meta?.maxTokens ?? null,
          symmetric: meta ? meta.queryPrefix === meta.documentPrefix : null,
        });
        seenModels.add(p.model);
      }

      if (opts.all) {
        const sorted = [...seed.entries()].sort((a, b) =>
          a[0].toLowerCase().localeCompare(b[0].toLowerCase()),
        );
        for (const [modelId, meta] of sorted) {
          if (seenModels.has(modelId)) continue;
          const presetMatch = presetByModel.get(modelId);
          // Provider inference: ids with `/` are HuggingFace (transformers
          // via transformers.js); bare basenames are typically Ollama tags.
          const provider = presetMatch?.provider ?? (modelId.includes('/') ? 'transformers' : 'ollama');
          rows.push({
            preset: presetMatch?.preset ?? null,
            model: modelId,
            provider,
            maxTokens: meta.maxTokens,
            symmetric: meta.queryPrefix === meta.documentPrefix,
          });
        }
      }

      const filtered = filter
        ? rows.filter((r) => r.model.toLowerCase().includes(filter))
        : rows;

      if (isTTY) {
        const header_label = opts.all ? 'Embedding models (presets + seed):' : 'Embedding presets:';
        process.stderr.write(`\n${header_label}\n\n`);
        const colW = [22, 44, 14, 10];
        const header = [
          'Preset'.padEnd(colW[0]),
          'Model'.padEnd(colW[1]),
          'Provider'.padEnd(colW[2]),
          'MaxTokens'.padEnd(colW[3]),
          'Symmetric',
        ].join('  ');
        process.stderr.write(header + '\n');
        process.stderr.write('-'.repeat(header.length) + '\n');
        for (const row of filtered) {
          process.stderr.write(
            [
              (row.preset ?? '—').padEnd(colW[0]),
              row.model.padEnd(colW[1]),
              row.provider.padEnd(colW[2]),
              String(row.maxTokens ?? '?').padEnd(colW[3]),
              String(row.symmetric ?? '?'),
            ].join('  ') + '\n',
          );
        }
        process.stderr.write(
          `\n(${filtered.length} models${filter ? ` matching "${filter}"` : ''}${opts.all ? '' : ' — pass --all for every seed entry'})\n\n`,
        );
      }

      printJson(filtered);
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
    // No --timeout option: `prefetchModel` has its own retry+backoff loop and
    // doesn't expose a top-level timeout. The flag was declared but `void`-ed
    // in pre-v1.7.5 code; removed rather than silently lying to users about
    // what it does.
    .action(async (presetArg: string | undefined) => {
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
      'from the seed → HF chain. Cheap for seeded models (~0 HF calls — the ' +
      '348-entry seed repopulates the cache instantly); 1 HF call per ' +
      'non-seeded BYOM id. The prefix-strategy hash auto-detects any prefix ' +
      'change and triggers a re-embed in bootstrap, so it is safe to run any ' +
      'time you suspect cached metadata is stale. Restart the server after ' +
      'running this. Caveat: if you run it OFFLINE on a non-seeded BYOM id, ' +
      'fallback safe defaults get cached — fix by running again online or ' +
      'editing the override file (`models override`).',
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
