import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isIgnoredWatchPath,
  toVaultRelativeId,
  WATCH_EXCLUDED_DIRS,
} from '../../src/pipeline/watch-paths.js';
import { EXCLUDED_DIRS } from '../../src/vault/parser.js';

/**
 * Issue #44: on Windows the watcher produced `\`-separated node ids (so
 * edited notes were indexed twice) and its ignore rules disagreed with the
 * full reindex about dot-folders. Windows behaviour is simulated with
 * `path.win32` so these run on any host.
 */

const file = { isDirectory: () => false };
const dir = { isDirectory: () => true };

describe('toVaultRelativeId — Windows (path.win32)', () => {
  const vault = 'C:\\Users\\me\\Vault';
  const w = path.win32;

  it('normalises backslash separators to "/" (matches the full reindex id)', () => {
    expect(toVaultRelativeId(vault, 'C:\\Users\\me\\Vault\\_logs\\2026-10-15.md', w)).toBe(
      '_logs/2026-10-15.md',
    );
    expect(toVaultRelativeId(vault, 'C:\\Users\\me\\Vault\\a\\b\\c.md', w)).toBe('a/b/c.md');
  });

  it('accepts forward-slash input (chokidar normalises paths for `ignored`)', () => {
    expect(toVaultRelativeId(vault, 'C:/Users/me/Vault/_logs/x.md', w)).toBe('_logs/x.md');
  });

  it('is case-insensitive about the vault prefix, like Windows itself', () => {
    expect(toVaultRelativeId(vault, 'c:\\users\\ME\\vault\\Note.md', w)).toBe('Note.md');
  });

  it('returns null for the vault root, a parent path and a different drive', () => {
    expect(toVaultRelativeId(vault, vault, w)).toBeNull();
    expect(toVaultRelativeId(vault, 'C:\\Users\\me\\Other\\x.md', w)).toBeNull();
    expect(toVaultRelativeId(vault, 'D:\\Vault\\x.md', w)).toBeNull();
  });
});

describe('toVaultRelativeId — POSIX (path.posix)', () => {
  const vault = '/home/me/vault';
  const p = path.posix;

  it('keeps "/" ids as-is', () => {
    expect(toVaultRelativeId(vault, '/home/me/vault/a/b.md', p)).toBe('a/b.md');
  });

  it('preserves a literal backslash in a POSIX filename (it is not a separator there)', () => {
    expect(toVaultRelativeId(vault, '/home/me/vault/odd\\name.md', p)).toBe('odd\\name.md');
  });

  it('does not mistake a "..name" file for a parent path', () => {
    expect(toVaultRelativeId(vault, '/home/me/vault/..notes.md', p)).toBe('..notes.md');
  });

  it('returns null outside the vault', () => {
    expect(toVaultRelativeId(vault, '/home/me/elsewhere.md', p)).toBeNull();
    expect(toVaultRelativeId(vault, '/home/me/vault', p)).toBeNull();
  });

  it('uses the host path module by default', () => {
    const root = path.resolve('/tmp/ob-vault');
    expect(toVaultRelativeId(root, path.join(root, 'x', 'y.md'))).toBe('x/y.md');
  });
});

describe('isIgnoredWatchPath — mirrors the full reindex', () => {
  const vault = 'C:\\Vault';
  const w = path.win32;

  it.each([
    ['C:\\Vault\\.obsidian\\workspace.json'],
    ['C:\\Vault\\.obsidian'],
    ['C:\\Vault\\.trash\\old.md'],
    ['C:\\Vault\\.git\\HEAD'],
    // Any dot-folder — not just the old fixed list.
    ['C:\\Vault\\.claude\\notes.md'],
    ['C:\\Vault\\Projects\\.drafts\\idea.md'],
    // Dot-files are skipped by the full reindex too.
    ['C:\\Vault\\.hidden.md'],
    // Excluded folder names, at any depth.
    ['C:\\Vault\\attachments\\x.md'],
    ['C:\\Vault\\sub\\node_modules\\pkg\\README.md'],
    ['C:\\Vault\\_FileOrganizer2000\\x.md'],
  ])('ignores %s with backslash separators', (p) => {
    expect(isIgnoredWatchPath(vault, p, undefined, w)).toBe(true);
  });

  it('ignores the same paths in the forward-slash form chokidar passes to `ignored`', () => {
    expect(isIgnoredWatchPath(vault, 'C:/Vault/.obsidian/app.json', undefined, w)).toBe(true);
    expect(isIgnoredWatchPath(vault, 'C:/Vault/.claude/x.md', file, w)).toBe(true);
  });

  it('keeps ordinary notes and folders', () => {
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Notes\\a.md', file, w)).toBe(false);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Notes', dir, w)).toBe(false);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Claude outputs\\a.md', file, w)).toBe(false);
    // Names that merely contain an excluded word are not excluded.
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\my attachments\\a.md', file, w)).toBe(false);
  });

  it('never ignores the vault root or paths outside it', () => {
    expect(isIgnoredWatchPath(vault, 'C:\\Vault', dir, w)).toBe(false);
    expect(isIgnoredWatchPath(vault, 'D:\\Else\\.obsidian', dir, w)).toBe(false);
  });

  it('matches relative to the vault, so a vault under a dot-folder still works', () => {
    const p = path.posix;
    const nested = '/home/me/.vaults/notes';
    expect(isIgnoredWatchPath(nested, '/home/me/.vaults/notes/a.md', file, p)).toBe(false);
    expect(isIgnoredWatchPath(nested, '/home/me/.vaults/notes/.obsidian', dir, p)).toBe(true);
  });

  it('filters non-markdown files only once stats say it is a file', () => {
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\img\\photo.png', file, w)).toBe(true);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\doc.PDF', file, w)).toBe(true);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Note.MD', file, w)).toBe(false);
    // Extension-less file: let it through (scheduleFile drops non-.md).
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\README', file, w)).toBe(false);
    // No stats yet: defer — chokidar re-checks with stats before watching.
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\img\\photo.png', undefined, w)).toBe(false);
  });

  it('descends into folders whose names look like extensions (e.g. "v1.2"), as the full reindex does', () => {
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Projects\\v1.2', dir, w)).toBe(false);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Projects\\v1.2', undefined, w)).toBe(false);
    expect(isIgnoredWatchPath(vault, 'C:\\Vault\\Projects\\v1.2\\plan.md', file, w)).toBe(false);
  });

  it('excluded-dir list carries the full-reindex names plus node_modules', () => {
    expect([...WATCH_EXCLUDED_DIRS].sort()).toEqual(
      ['_FileOrganizer2000', 'attachments', 'node_modules'].sort(),
    );
  });

  it('excluded-dir list is derived from the full reindex list (minus dot-names, skipped separately)', () => {
    expect([...WATCH_EXCLUDED_DIRS].sort()).toEqual(
      [...EXCLUDED_DIRS].filter((n) => !n.startsWith('.')).sort(),
    );
  });
});
