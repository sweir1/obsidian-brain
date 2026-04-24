/**
 * `obsidian-brain models` subcommand group.
 *
 * Subcommands:
 *   models list                   — print EMBEDDING_PRESETS as JSON (structured)
 *   models recommend              — inspect vault, suggest best preset
 *   models prefetch [preset]      — warm the HF cache for a preset's model
 *   models check <id>             — load a specific model id, validate, print metadata
 *
 * Register via `registerModelsCommands(program)` after the top-level
 * commands in src/cli/index.ts.
 */

import type { Command } from 'commander';
import { EMBEDDING_PRESETS, type EmbeddingPresetName } from '../embeddings/presets.js';
import { getTransformersPrefix } from '../embeddings/embedder.js';
import { prefetchModel } from '../embeddings/prefetch.js';
import { autoRecommendPreset } from '../embeddings/auto-recommend.js';
import { KNOWN_MAX_TOKENS } from '../embeddings/capacity.js';

/**
 * Look up the advertised max-token count from the validation table, keyed on
 * the full model id. Falls back to checking last path segment (lower-cased),
 * then falls back to `rawValue` (what the tokenizer config reports) when not
 * found.
 */
function resolveAdvertisedMaxTokens(
  modelId: string,
  rawValue: number | undefined,
): number | undefined {
  // Try full model id first (capacity.ts table uses full ids).
  if (KNOWN_MAX_TOKENS[modelId] !== undefined) {
    return KNOWN_MAX_TOKENS[modelId];
  }
  // Fallback: last path segment lower-cased (legacy compat).
  const segment = modelId.split('/').pop()?.toLowerCase() ?? '';
  for (const [key, val] of Object.entries(KNOWN_MAX_TOKENS)) {
    if (key.split('/').pop()?.toLowerCase() === segment) {
      return val;
    }
  }
  return rawValue;
}

// ---------------------------------------------------------------------------
// Symmetry heuristic
// ---------------------------------------------------------------------------

function deriveSymmetric(modelId: string): boolean {
  const m = modelId.toLowerCase();
  // Check EMBEDDING_PRESETS first for any preset that matches this model.
  for (const preset of Object.values(EMBEDDING_PRESETS)) {
    if (preset.model.toLowerCase() === m) return preset.symmetric;
  }
  // Heuristic fallback.
  if (m.includes('minilm') || m.includes('jina-v2') || m.includes('jina-embeddings-v2')) {
    return true;
  }
  if (m.includes('multilingual-e5') || m.includes('bge')) {
    return false;
  }
  // Default: assume asymmetric (safer — wrong prefix hurts less than missing one).
  return false;
}

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
    .description('List all available embedding presets (zero network calls)')
    .action(() => {
      const isTTY = process.stdout.isTTY;

      // Always write machine-readable JSON to stdout.
      const data = Object.entries(EMBEDDING_PRESETS).map(([name, p]) => ({
        preset: name,
        model: p.model,
        sizeMb: p.sizeMb,
        lang: p.lang,
        symmetric: p.symmetric,
      }));

      if (isTTY) {
        // Human-friendly table to stderr.
        process.stderr.write('\nEmbedding presets:\n\n');
        const colW = [14, 38, 8, 14, 10];
        const header = [
          'Preset'.padEnd(colW[0]),
          'Model'.padEnd(colW[1]),
          'SizeMb'.padEnd(colW[2]),
          'Lang'.padEnd(colW[3]),
          'Symmetric',
        ].join('  ');
        process.stderr.write(header + '\n');
        process.stderr.write('-'.repeat(header.length) + '\n');
        for (const row of data) {
          process.stderr.write(
            [
              row.preset.padEnd(colW[0]),
              row.model.padEnd(colW[1]),
              String(row.sizeMb).padEnd(colW[2]),
              row.lang.padEnd(colW[3]),
              String(row.symmetric),
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
        // Defensive branch — autoRecommendPreset returns AutoRecommendResult (never null)
        // but we handle null gracefully for forward-compatibility.
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
        maxAttempts: 4,
        backoffBaseMs: 1000,
      });

      const durationMs = Date.now() - started;
      void opts.timeout; // declared for commander, network timeout not yet threaded through

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
    .description('Load a model by HF id, validate, and print metadata.')
    .option('--timeout <ms>', 'Load timeout in ms', (v) => parseInt(v, 10), 60_000)
    .action(async (id: string, opts: { timeout: number }) => {
      const timeoutMs = opts.timeout ?? 60_000;

      process.stderr.write(
        `obsidian-brain: checking model "${id}"…\n`,
      );

      let result;
      try {
        result = await Promise.race([
          prefetchModel(id, { maxAttempts: 4, backoffBaseMs: 1000 }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`models check: timed out after ${timeoutMs}ms loading ${id}`)),
              timeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        process.stderr.write(
          `obsidian-brain: model check failed: ${(err as Error)?.message ?? String(err)}\n`,
        );
        process.exit(1);
      }

      // Resolve advertisedMaxTokens — prefer known table, then tokenizer config.
      const advertisedMaxTokens = resolveAdvertisedMaxTokens(id, undefined);

      const symmetric = deriveSymmetric(id);
      const expectedQueryPrefix = getTransformersPrefix(id, 'query');

      printJson({
        model: result.model,
        dim: result.dim,
        advertisedMaxTokens: advertisedMaxTokens ?? null,
        symmetric,
        expectedQueryPrefix,
        ready: true,
      });
    });
}
