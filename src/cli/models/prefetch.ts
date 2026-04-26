import type { Command } from 'commander';
import {
  EMBEDDING_PRESETS,
  DEFAULT_PRESET,
  type EmbeddingPresetName,
} from '../../embeddings/presets.js';
import { prefetchModel } from '../../embeddings/prefetch.js';
import { printJson } from './output.js';

export function registerPrefetchCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models prefetch [preset]
  // -------------------------------------------------------------------------
  parent
    .command('prefetch [preset]')
    .description(
      `Warm the HF cache for a preset's model. Defaults to the "${DEFAULT_PRESET}" preset.`,
    )
    // No --timeout option: `prefetchModel` has its own retry+backoff loop and
    // doesn't expose a top-level timeout. The flag was declared but `void`-ed
    // in pre-v1.7.5 code; removed rather than silently lying to users about
    // what it does.
    .action(async (presetArg: string | undefined) => {
      const presetName: EmbeddingPresetName =
        ((presetArg?.toLowerCase().trim() ?? DEFAULT_PRESET) as EmbeddingPresetName);

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
}
