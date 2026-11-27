import path from 'node:path';
import { EXCLUDED_DIRS, getVaultIgnore, type VaultIgnore } from '../vault/ignore.js';

/**
 * Path helpers for the live watcher (src/pipeline/watcher.ts).
 *
 * **Why these exist.** Node ids are vault-relative paths with `/`
 * separators — that is what the full reindex (`collectMarkdownFiles` in
 * src/vault/parser.ts) produces on every platform. The watcher used to
 * build ids with `path.relative()`, which on Windows yields `\`-separated
 * paths, so every note edited while the server ran was indexed a second
 * time under a `\` id. It also only skipped a fixed list of folders, while
 * the full reindex skips every dot-prefixed entry, so the two disagreed
 * about what belongs in the index.
 *
 * Both helpers take an optional `path` implementation so tests can run the
 * Windows behaviour (`path.win32`) on any host.
 */

type PathApi = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Folder names the watcher skips, in addition to every dot-prefixed entry.
 * Derived from the full reindex's `EXCLUDED_DIRS` (src/vault/parser.ts) so
 * the two can't disagree about what belongs in the index. Dot-prefixed names
 * (`.obsidian`) are dropped here because {@link isIgnoredWatchPath} already
 * skips every dot-prefixed segment.
 */
export const WATCH_EXCLUDED_DIRS: ReadonlySet<string> = new Set(
  [...EXCLUDED_DIRS].filter((name) => !name.startsWith('.')),
);

/** Minimal `fs.Stats` surface chokidar may hand to the `ignored` callback. */
export interface MaybeStats {
  isDirectory(): boolean;
}

/**
 * Convert a path reported by the watcher into a vault-relative node id
 * with `/` separators. Returns `null` for the vault root itself and for
 * paths outside the vault (including a different drive on Windows).
 *
 * Only the platform separator is rewritten: on POSIX a `\` is a legal
 * filename character and must survive, exactly as the full reindex keeps it.
 */
export function toVaultRelativeId(
  vaultPath: string,
  absPath: string,
  pathApi: PathApi = path,
): string | null {
  const rel = pathApi.relative(vaultPath, absPath);
  if (rel === '' || pathApi.isAbsolute(rel)) return null;
  const segments = rel.split(pathApi.sep);
  if (segments[0] === '..') return null;
  return segments.join('/');
}

/**
 * chokidar `ignored` predicate. Mirrors what the full reindex walks:
 *
 *   - any path with a dot-prefixed segment (`.obsidian`, `.trash`, `.git`,
 *     `.claude`, dot-files, ...) is skipped;
 *   - any segment named in {@link WATCH_EXCLUDED_DIRS} is skipped;
 *   - anything the user excluded (`.obsidianbrainignore`,
 *     `OBSIDIAN_BRAIN_IGNORE`, optionally Obsidian's Excluded files) is
 *     skipped — a directory is pruned so chokidar never descends into it.
 *     chokidar first calls this without stats, so an unknown entry is
 *     tested both as a file and as a directory;
 *   - files with a non-`.md` extension are skipped so chokidar doesn't hold
 *     a watch handle per image/PDF. That filter is only applied once
 *     chokidar has told us the entry is not a directory — a folder like
 *     `Projects/v1.2` looks like it has an extension but must still be
 *     descended into, as the full reindex does. chokidar always re-checks
 *     with stats before watching an entry, so deferring the filter to that
 *     call is safe.
 *
 * Paths are matched relative to the vault, so a vault that itself lives
 * under a dot-folder (e.g. `~/.vaults/notes`) is still watched.
 */
export function isIgnoredWatchPath(
  vaultPath: string,
  absPath: string,
  stats?: MaybeStats,
  pathApi: PathApi = path,
  ig: VaultIgnore = getVaultIgnore(vaultPath),
): boolean {
  const id = toVaultRelativeId(vaultPath, absPath, pathApi);
  if (id === null) return false;
  const segments = id.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.') || WATCH_EXCLUDED_DIRS.has(segment)) return true;
  }
  if (!ig.empty) {
    if (stats === undefined) {
      if (ig.isUserExcluded(id, false) || ig.isUserExcluded(id, true)) return true;
    } else if (ig.isUserExcluded(id, stats.isDirectory())) {
      return true;
    }
  }
  if (!stats || stats.isDirectory()) return false;
  const name = segments[segments.length - 1]!;
  return /\.[A-Za-z0-9]+$/.test(name) && !/\.md$/i.test(name);
}
