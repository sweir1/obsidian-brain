import type { Command } from 'commander';
import {
  EMBEDDING_PRESETS,
} from '../../embeddings/presets.js';
import { loadSeed } from '../../embeddings/seed-loader.js';
import { printJson } from './output.js';

export function registerListCommand(parent: Command): void {
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
  parent
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
}
