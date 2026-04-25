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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMBEDDING_PRESETS, type EmbeddingPresetName } from '../embeddings/presets.js';
import { prefetchModel } from '../embeddings/prefetch.js';
import { autoRecommendPreset } from '../embeddings/auto-recommend.js';
import { loadSeed } from '../embeddings/seed-loader.js';
import { getEmbeddingMetadata } from '../embeddings/hf-metadata.js';
import { clearMetadataCache } from '../embeddings/metadata-cache.js';
import {
  loadOverrides,
  saveOverride,
  removeOverride,
  type ModelOverride,
} from '../embeddings/overrides.js';
import { getOverridesPath, getUserSeedPath } from '../embeddings/user-config.js';
import { openDb } from '../store/db.js';
import { resolveDataConfig } from '../config.js';

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
  models
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
  models
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

  // -------------------------------------------------------------------------
  // models fetch-seed [--url <url>] [--check]
  //
  // Download the latest `data/seed-models.json` from the obsidian-brain main
  // branch on GitHub and write it to ~/.config/obsidian-brain/seed-models.json.
  // The seed-loader checks the user-fetched path BEFORE the bundled npm
  // tarball copy, so users get upstream MTEB fixes without waiting for an
  // npm release.
  //
  // The fetched seed must validate against the current schema (v2). On
  // mismatch we refuse to overwrite and print a clear error — schema bumps
  // require a package update.
  // -------------------------------------------------------------------------
  const DEFAULT_SEED_URL =
    'https://raw.githubusercontent.com/sweir1/obsidian-brain/main/data/seed-models.json';

  models
    .command('fetch-seed')
    .description(
      'Download the latest data/seed-models.json from the obsidian-brain main ' +
      'branch on GitHub. Bypasses waiting for an npm release when MTEB ships ' +
      'an upstream fix. Writes to ~/.config/obsidian-brain/seed-models.json; ' +
      'the seed-loader picks it up automatically over the bundled package ' +
      'copy. Pass --check to validate the download without writing.',
    )
    .option('--url <url>', 'Override the source URL (e.g. for a fork)', DEFAULT_SEED_URL)
    .option('--check', 'Download + validate; do not write to disk', false)
    .option('--timeout <ms>', 'HTTP timeout in ms', (v) => parseInt(v, 10), 30_000)
    .action(async (opts: { url: string; check: boolean; timeout: number }) => {
      process.stderr.write(`obsidian-brain: fetching seed from ${opts.url}…\n`);

      let payload: string;
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), opts.timeout);
        const res = await fetch(opts.url, { signal: ac.signal });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(
            `obsidian-brain: fetch-seed: HTTP ${res.status} ${res.statusText}\n`,
          );
          process.exit(1);
        }
        payload = await res.text();
      } catch (err) {
        process.stderr.write(
          `obsidian-brain: fetch-seed: download failed: ${(err as Error).message ?? String(err)}\n`,
        );
        process.exit(1);
      }

      // Validate shape before touching disk.
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        process.stderr.write(
          `obsidian-brain: fetch-seed: response is not valid JSON: ${(err as Error).message}\n`,
        );
        process.exit(1);
      }

      if (!parsed || typeof parsed !== 'object') {
        process.stderr.write('obsidian-brain: fetch-seed: response is not an object\n');
        process.exit(1);
      }
      const file = parsed as { $schemaVersion?: number; models?: Record<string, unknown> };
      if (file.$schemaVersion !== 2) {
        process.stderr.write(
          `obsidian-brain: fetch-seed: unsupported $schemaVersion ${file.$schemaVersion ?? '?'} ` +
          `(expected 2 — upgrade obsidian-brain to a version that supports this schema)\n`,
        );
        process.exit(1);
      }
      if (!file.models || typeof file.models !== 'object') {
        process.stderr.write('obsidian-brain: fetch-seed: response has no `models` object\n');
        process.exit(1);
      }
      const entryCount = Object.keys(file.models).length;
      if (entryCount === 0) {
        process.stderr.write('obsidian-brain: fetch-seed: response has zero entries — refusing\n');
        process.exit(1);
      }

      const target = getUserSeedPath();
      if (opts.check) {
        printJson({
          url: opts.url,
          schemaVersion: file.$schemaVersion,
          entries: entryCount,
          targetPath: target,
          wrote: false,
          note: 'validation-only mode (--check); no file written',
        });
        return;
      }

      mkdirSync(dirname(target), { recursive: true });
      const tmp = target + '.tmp';
      writeFileSync(tmp, payload, 'utf-8');
      // Atomic rename so a partial write never leaves a corrupt seed.
      const fs = await import('node:fs/promises');
      await fs.rename(tmp, target);

      printJson({
        url: opts.url,
        schemaVersion: file.$schemaVersion,
        entries: entryCount,
        wrote: target,
        nextBoot:
          'seed-loader will pick up the user-fetched seed on next server boot. ' +
          'Run `models refresh-cache` then restart the server to apply immediately ' +
          'to existing cache rows.',
      });
    });
}
