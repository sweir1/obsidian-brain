import type { Command } from 'commander';
import {
  loadOverrides,
  saveOverride,
  removeOverride,
  type ModelOverride,
} from '../../embeddings/overrides.js';
import { getOverridesPath } from '../../embeddings/user-config.js';
import { printJson } from './output.js';

export function registerOverrideCommand(parent: Command): void {
  // -------------------------------------------------------------------------
  // models override <id> [--max-tokens N] [--query-prefix S] [--document-prefix S]
  //                      [--remove [--field name]] [--list]
  //
  // Read / write user-controlled overrides at
  // `~/.config/obsidian-brain/model-overrides.json`. Survives `npm update`
  // because it lives outside the package directory. The resolver chain
  // applies overrides as the topmost layer (override → cache → seed →
  // HF → embedder probe → fallback) — any overridden field replaces the
  // resolved value. Prefix changes auto-trigger a re-embed via the
  // existing prefix-strategy hash in bootstrap; maxTokens changes take
  // effect on the next reindex.
  //
  // Three modes:
  //   - `models override <id> --max-tokens 1024 [--query-prefix S]` — set/patch
  //   - `models override <id> --remove [--field name]` — clear all or one
  //   - `models override --list` — dump every override as JSON
  // -------------------------------------------------------------------------
  parent
    .command('override [id]')
    .description(
      'Set, remove, or list user-controlled metadata overrides at ' +
      '~/.config/obsidian-brain/model-overrides.json. Survives `npm update`. ' +
      'Use to correct upstream MTEB/HF errors locally — e.g. ' +
      '`models override BAAI/bge-small-en-v1.5 --max-tokens 1024`. ' +
      'Restart the server after running this; prefix changes auto-trigger ' +
      'a re-embed via the prefix-strategy hash in bootstrap.',
    )
    .option('--max-tokens <n>', 'Override maxTokens (positive integer)', (v) => parseInt(v, 10))
    .option('--query-prefix <s>', 'Override the query-side prefix string')
    .option('--document-prefix <s>', 'Override the document-side prefix string')
    .option('--remove', 'Remove the override for this id (or one of its fields with --field)', false)
    .option('--field <name>', 'With --remove: clear only this field (maxTokens|queryPrefix|documentPrefix)')
    .option('--list', 'List every override on disk and exit (no <id> required)', false)
    .action(
      (
        idArg: string | undefined,
        opts: {
          maxTokens?: number;
          queryPrefix?: string;
          documentPrefix?: string;
          remove: boolean;
          field?: string;
          list: boolean;
        },
      ) => {
        // --list: dump everything and exit. <id> not required.
        if (opts.list) {
          const all = loadOverrides();
          const obj: Record<string, ModelOverride> = {};
          for (const [k, v] of all.entries()) obj[k] = v;
          printJson({
            path: getOverridesPath(),
            count: all.size,
            overrides: obj,
          });
          return;
        }

        if (!idArg) {
          process.stderr.write(
            'obsidian-brain: models override: <id> is required (or pass --list to dump all)\n',
          );
          process.exit(1);
        }

        // --remove: clear an entry (or one field).
        if (opts.remove) {
          const fieldArg = opts.field as keyof ModelOverride | undefined;
          if (fieldArg && !['maxTokens', 'queryPrefix', 'documentPrefix'].includes(fieldArg)) {
            process.stderr.write(
              `obsidian-brain: models override: --field must be one of maxTokens|queryPrefix|documentPrefix (got "${fieldArg}")\n`,
            );
            process.exit(1);
          }
          const removed = removeOverride(idArg, fieldArg);
          printJson({
            id: idArg,
            removed,
            field: fieldArg ?? null,
            path: getOverridesPath(),
          });
          return;
        }

        // Set/patch path. At least one field flag must be present.
        const patch: ModelOverride = {};
        if (typeof opts.maxTokens === 'number') {
          if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
            process.stderr.write(
              `obsidian-brain: models override: --max-tokens must be a positive integer (got ${opts.maxTokens})\n`,
            );
            process.exit(1);
          }
          patch.maxTokens = Math.floor(opts.maxTokens);
        }
        if (opts.queryPrefix !== undefined) patch.queryPrefix = opts.queryPrefix;
        if (opts.documentPrefix !== undefined) patch.documentPrefix = opts.documentPrefix;

        if (Object.keys(patch).length === 0) {
          process.stderr.write(
            'obsidian-brain: models override: no override fields specified. Pass at least one of ' +
            '--max-tokens, --query-prefix, --document-prefix; or --remove; or --list.\n',
          );
          process.exit(1);
        }

        saveOverride(idArg, patch);
        printJson({
          id: idArg,
          applied: patch,
          path: getOverridesPath(),
          nextBoot:
            'override takes effect on next server boot. Run `models refresh-cache --model ' +
            idArg +
            '` then restart the server to apply immediately.',
        });
      },
    );
}
