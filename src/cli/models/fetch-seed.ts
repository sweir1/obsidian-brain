import type { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getUserSeedPath } from '../../embeddings/user-config.js';
import { printJson } from './output.js';

export const DEFAULT_SEED_URL =
  'https://raw.githubusercontent.com/sweir1/obsidian-brain/main/data/seed-models.json';

export function registerFetchSeedCommand(parent: Command): void {
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
  parent
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
