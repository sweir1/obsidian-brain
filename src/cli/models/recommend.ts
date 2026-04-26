import type { Command } from 'commander';
import {
  EMBEDDING_PRESETS,
} from '../../embeddings/presets.js';
import { autoRecommendPreset } from '../../embeddings/auto-recommend.js';
import { printJson } from './output.js';

export function registerRecommendCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models recommend
  // -------------------------------------------------------------------------
  parent
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
}
