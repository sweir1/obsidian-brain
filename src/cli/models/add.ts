import type { Command } from 'commander';
import { loadSeed } from '../../embeddings/seed-loader.js';
import {
  loadOverrides,
  saveOverride,
} from '../../embeddings/overrides.js';
import { getOverridesPath } from '../../embeddings/user-config.js';
import { printJson } from './output.js';

export function registerAddCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models add <id> --max-tokens N [--query-prefix S] [--document-prefix S]
  //
  // Register a model NOT in the bundled seed (peer to `models override`,
  // which patches existing entries). Writes to the same
  // `~/.config/obsidian-brain/model-overrides.json` file used by override.
  // Asserts the id is NOT already in the seed — pointing the user at
  // `models override` if it is. With all three load-bearing fields set,
  // the resolver short-circuits HF entirely on lookups for this id (the
  // override is self-contained metadata; nothing useful HF could add).
  //
  // Defaults:
  //   --query-prefix:    "" (symmetric query side)
  //   --document-prefix: "" (symmetric document side)
  //
  // Use case: a user runs an obscure HF model that MTEB doesn't track,
  // wants to ship its prefixes via a dotfile-managed overrides file.
  // -------------------------------------------------------------------------
  parent
    .command('add <id>')
    .description(
      'Register a new model not in the bundled seed. Required: --max-tokens. ' +
      'Optional: --query-prefix, --document-prefix (default ""). Asserts the ' +
      'id is not already in the seed (use `models override` for existing ids). ' +
      'Writes to ~/.config/obsidian-brain/model-overrides.json; survives `npm ' +
      'update`. Restart the server after running this.',
    )
    .requiredOption('--max-tokens <n>', 'Effective max input tokens (positive integer; load-bearing)', (v) => parseInt(v, 10))
    .option('--query-prefix <s>', 'Query-side prefix string (default: "")', '')
    .option('--document-prefix <s>', 'Document-side prefix string (default: "")', '')
    .action(
      (
        id: string,
        opts: { maxTokens: number; queryPrefix: string; documentPrefix: string },
      ) => {
        if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
          process.stderr.write(
            `obsidian-brain: models add: --max-tokens must be a positive integer (got ${opts.maxTokens})\n`,
          );
          process.exit(1);
        }
        // Refuse if already in (a) the bundled / user-fetched seed, or
        // (b) the user override file. Overlapping ids should go through
        // `models override` so users get one clear API per intent:
        // "register new" vs "patch existing." Running `models add` twice
        // on the same id silently overwriting would be bad UX — make it
        // a hard error and direct them to the right command.
        const seed = loadSeed();
        if (seed.has(id)) {
          process.stderr.write(
            `obsidian-brain: models add: "${id}" is already in the seed. ` +
            `Use \`models override ${id}\` to patch the seeded entry instead.\n`,
          );
          process.exit(1);
        }
        const existingOverrides = loadOverrides();
        if (existingOverrides.has(id)) {
          process.stderr.write(
            `obsidian-brain: models add: "${id}" already has an override. ` +
            `Use \`models override ${id}\` to patch it, or ` +
            `\`models override ${id} --remove\` to clear it first.\n`,
          );
          process.exit(1);
        }
        saveOverride(id, {
          maxTokens: Math.floor(opts.maxTokens),
          queryPrefix: opts.queryPrefix,
          documentPrefix: opts.documentPrefix,
        });
        printJson({
          id,
          added: {
            maxTokens: Math.floor(opts.maxTokens),
            queryPrefix: opts.queryPrefix,
            documentPrefix: opts.documentPrefix,
          },
          path: getOverridesPath(),
          nextBoot:
            'override-as-seed-entry takes effect on next server boot. The ' +
            'resolver short-circuits HF entirely for this id since all three ' +
            'load-bearing fields are now specified.',
        });
      },
    );
}
