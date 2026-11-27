import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { logger } from '../util/logger.js';

/**
 * User-configurable exclusions: which vault paths obsidian-brain must never
 * index, on top of the built-in rules (every dot-prefixed entry, plus the
 * folders in `EXCLUDED_DIRS`).
 *
 * Three sources, all optional:
 *
 *   1. `.obsidianbrainignore` at the vault root — gitignore syntax.
 *   2. `OBSIDIAN_BRAIN_IGNORE` — the same syntax as a comma- or
 *      newline-separated list, or a JSON array (for names containing commas).
 *      Loaded after the file, so a `!pattern` here can re-include something
 *      the file excluded.
 *   3. Obsidian's own Settings → Files and links → Excluded files
 *      (`userIgnoreFilters` in `.obsidian/app.json`), only when
 *      `OBSIDIAN_BRAIN_HONOR_EXCLUDED_FILES` is truthy. Matched the way
 *      Obsidian matches them: a plain entry is a path prefix, `/.../` is a
 *      regular expression.
 *
 * Paths are vault-relative with `/` separators (the node-id form). Matching
 * is case-insensitive and Unicode-normalised (NFC), so `Café` matches
 * however the filesystem spelled it.
 *
 * Every walker (full reindex, startup catch-up, live watcher, single-note
 * writes, vault_health) asks the same {@link VaultIgnore}, via
 * {@link getVaultIgnore}, so they can never disagree about what belongs in
 * the index.
 */

/**
 * Folder names never indexed, at any depth (in addition to every
 * dot-prefixed entry). Re-exported by src/vault/parser.ts.
 */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['.obsidian', '_FileOrganizer2000', 'attachments', 'node_modules']);

export const IGNORE_FILE_NAME = '.obsidianbrainignore';
export const IGNORE_ENV = 'OBSIDIAN_BRAIN_IGNORE';
export const HONOR_EXCLUDED_FILES_ENV = 'OBSIDIAN_BRAIN_HONOR_EXCLUDED_FILES';

export interface VaultIgnoreRules {
  /** Lines from `.obsidianbrainignore` (comments and blanks dropped). */
  file: string[];
  /** Patterns from `OBSIDIAN_BRAIN_IGNORE`. */
  env: string[];
  /** Obsidian Excluded files entries (empty unless honoured). */
  obsidian: string[];
}

export interface VaultIgnore {
  /** True if a user rule excludes this vault-relative path. */
  isUserExcluded(relPath: string, isDir: boolean): boolean;
  /** Built-in rules OR user rules. */
  isExcluded(relPath: string, isDir: boolean): boolean;
  /** True when no user rule is configured. */
  readonly empty: boolean;
  readonly rules: VaultIgnoreRules;
}

/**
 * The built-in rules every walker has always applied: any dot-prefixed
 * segment, and any *directory* segment named in `EXCLUDED_DIRS`.
 */
export function isBuiltinExcluded(relPath: string, isDir: boolean): boolean {
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('.')) return true;
    const segIsDir = i < segments.length - 1 || isDir;
    if (segIsDir && EXCLUDED_DIRS.has(seg)) return true;
  }
  return false;
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Split `OBSIDIAN_BRAIN_IGNORE` into patterns. Accepts a JSON array, or a
 * comma / newline separated list. Windows-style paths are converted to `/`,
 * a leading `./` anchors to the vault root, and an absolute path inside the
 * vault becomes an anchored vault-relative pattern (people paste
 * `C:\Users\me\Vault\Claude outputs`). Absolute paths outside the vault are
 * dropped with a warning.
 */
export function parseIgnoreEnv(
  raw: string | undefined,
  vaultPath: string,
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'> = path,
): string[] {
  if (!raw || raw.trim() === '') return [];
  const trimmed = raw.trim();
  let items: string[] | null = null;
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) items = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* not JSON after all — fall through to the list form */
    }
  }
  if (items === null) items = trimmed.split(/[\n,]/);

  const out: string[] = [];
  for (const item of items) {
    const p = normaliseEnvPattern(item.trim(), vaultPath, pathApi);
    if (p !== null) out.push(p);
  }
  return out;
}

function normaliseEnvPattern(
  entry: string,
  vaultPath: string,
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>,
): string | null {
  if (entry === '') return null;
  let negate = '';
  let body = entry;
  if (body.startsWith('!')) {
    negate = '!';
    body = body.slice(1);
  }
  const trailingSlash = /[\\/]$/.test(body);
  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(body) || body.startsWith('\\\\');
  if (pathApi.isAbsolute(body) || looksWindowsAbsolute) {
    const winVault = /^[A-Za-z]:[\\/]/.test(vaultPath) || vaultPath.startsWith('\\\\');
    const api = looksWindowsAbsolute || winVault ? path.win32 : pathApi;
    const rel = api.relative(vaultPath, body);
    if (rel === '' || rel.startsWith('..') || api.isAbsolute(rel)) {
      logger.warn(`${IGNORE_ENV}: ignoring '${entry}' — it is outside the vault`, { entry });
      return null;
    }
    body = '/' + rel.split(/[\\/]/).join('/') + (trailingSlash ? '/' : '');
    return negate + body;
  }
  // Relative entry. A backslash is a path separator for anyone pasting a
  // Windows path; keep gitignore's `\#` / `\!` escapes at the start.
  if (!/^\\[#!]/.test(body)) body = body.replace(/\\/g, '/');
  if (body.startsWith('./')) body = '/' + body.slice(2);
  return body === '' || body === '/' ? null : negate + body;
}

/** Read `userIgnoreFilters` from `.obsidian/app.json`; [] when absent or unreadable. */
export function readObsidianExcludedFiles(vaultPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(vaultPath, '.obsidian', 'app.json'), 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { userIgnoreFilters?: unknown };
    const list = parsed?.userIgnoreFilters;
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } catch {
    logger.warn('could not parse .obsidian/app.json — Excluded files not applied');
    return [];
  }
}

/**
 * Compile Obsidian's Excluded files entries. Obsidian matches a plain entry
 * as a prefix of the vault-relative path (`Archive/` excludes the folder;
 * `Archive` also excludes `Archive.md` and `Archive 2/`), and an entry
 * wrapped in slashes as a JavaScript regular expression. Entries Obsidian
 * itself ignores — invalid regexes, `#tag` lines — match nothing.
 */
function compileObsidianFilters(entries: string[]): Array<(p: string) => boolean> {
  const out: Array<(p: string) => boolean> = [];
  for (const e of entries) {
    const entry = e.normalize('NFC');
    if (entry.startsWith('#')) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(entry);
    if (re) {
      try {
        const rx = new RegExp(re[1]!, re[2]!.replace(/[gy]/g, ''));
        out.push((p) => rx.test(p));
      } catch {
        logger.warn(`Excluded files: invalid regular expression '${entry}' skipped`, { entry });
      }
      continue;
    }
    out.push((p) => p.startsWith(entry));
  }
  return out;
}

function readIgnoreFile(vaultPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(vaultPath, IGNORE_FILE_NAME), 'utf-8');
  } catch {
    return [];
  }
  return raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    // Trailing whitespace is dropped unless escaped with a backslash, as in git.
    .map((l) => l.replace(/(?<!\\)\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
}

/** Build a matcher from the vault's current rules. No caching. */
export function loadVaultIgnore(
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
): VaultIgnore {
  const rules: VaultIgnoreRules = {
    file: readIgnoreFile(vaultPath),
    env: parseIgnoreEnv(env.OBSIDIAN_BRAIN_IGNORE, vaultPath),
    obsidian: isTruthy(env.OBSIDIAN_BRAIN_HONOR_EXCLUDED_FILES) ? readObsidianExcludedFiles(vaultPath) : [],
  };
  return buildVaultIgnore(rules);
}

/** Build a matcher from explicit rules (tests, and {@link loadVaultIgnore}). */
export function buildVaultIgnore(rules: VaultIgnoreRules): VaultIgnore {
  const gitStyle = [...rules.file, ...rules.env].map((p) => p.normalize('NFC'));
  let ig: Ignore | null = null;
  if (gitStyle.length > 0) {
    ig = ignore({ ignorecase: true });
    for (const p of gitStyle) {
      try {
        ig.add(p);
      } catch {
        logger.warn(`ignore pattern '${p}' is invalid and was skipped`, { pattern: p });
      }
    }
  }
  const obsidian = compileObsidianFilters(rules.obsidian);
  const empty = ig === null && obsidian.length === 0;

  const isUserExcluded = (relPath: string, isDir: boolean): boolean => {
    if (empty || relPath === '') return false;
    const p = relPath.normalize('NFC');
    if (ig !== null) {
      try {
        if (ig.ignores(isDir ? `${p}/` : p)) return true;
      } catch {
        /* `ignore` throws on paths it can't express (absolute, `./`); not ours */
      }
    }
    if (obsidian.length > 0) {
      const probe = isDir ? `${p}/` : p;
      for (const m of obsidian) if (m(probe) || m(p)) return true;
    }
    return false;
  };

  return {
    isUserExcluded,
    isExcluded: (relPath, isDir) => isBuiltinExcluded(relPath, isDir) || isUserExcluded(relPath, isDir),
    empty,
    rules,
  };
}

// ---- cached access ---------------------------------------------------------

interface CacheEntry {
  ig: VaultIgnore;
  key: string;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();
/** How often {@link getVaultIgnore} re-checks the rule sources for changes. */
const RECHECK_MS = 1_000;

function mtimeOf(p: string): string {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

function sourceKey(vaultPath: string, env: NodeJS.ProcessEnv): string {
  const honor = isTruthy(env.OBSIDIAN_BRAIN_HONOR_EXCLUDED_FILES);
  return [
    mtimeOf(path.join(vaultPath, IGNORE_FILE_NAME)),
    env.OBSIDIAN_BRAIN_IGNORE ?? '',
    honor ? mtimeOf(path.join(vaultPath, '.obsidian', 'app.json')) : 'off',
  ].join('|');
}

/**
 * The matcher for a vault, rebuilt whenever `.obsidianbrainignore`, the env
 * var or (when honoured) `.obsidian/app.json` changes. Cheap to call on hot
 * paths: the sources are re-checked at most once a second.
 */
export function getVaultIgnore(
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
): VaultIgnore {
  const now = Date.now();
  const hit = cache.get(vaultPath);
  if (hit && now - hit.checkedAt < RECHECK_MS) return hit.ig;
  const key = sourceKey(vaultPath, env);
  if (hit && hit.key === key) {
    hit.checkedAt = now;
    return hit.ig;
  }
  const ig = loadVaultIgnore(vaultPath, env);
  cache.set(vaultPath, { ig, key, checkedAt: now });
  if (!ig.empty || (hit && !hit.ig.empty)) {
    const { file, env: envRules, obsidian } = ig.rules;
    logger.info(
      `exclusions: ${file.length} rule(s) from ${IGNORE_FILE_NAME}, ${envRules.length} from ${IGNORE_ENV}, ${obsidian.length} from Obsidian's Excluded files`,
      { fileRules: file.length, envRules: envRules.length, obsidianRules: obsidian.length },
    );
  }
  return ig;
}

/** Drop cached matchers (tests). */
export function clearVaultIgnoreCache(): void {
  cache.clear();
}
