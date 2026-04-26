import type { Command } from 'commander';
import { prefetchModel } from '../../embeddings/prefetch.js';
import { getEmbeddingMetadata } from '../../embeddings/hf-metadata.js';
import { printJson } from './output.js';

export function registerCheckCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models check <id>
  // -------------------------------------------------------------------------
  parent
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
}
