import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVaultIgnore,
  clearVaultIgnoreCache,
  getVaultIgnore,
  HONOR_EXCLUDED_FILES_ENV,
  IGNORE_ENV,
  IGNORE_FILE_NAME,
  isBuiltinExcluded,
  loadVaultIgnore,
  parseIgnoreEnv,
  readObsidianExcludedFiles,
} from '../../src/vault/ignore.js';

/** Issue #44 — user-configurable exclusions. */

const rules = (file: string[] = [], env: string[] = [], obsidian: string[] = []) =>
  buildVaultIgnore({ file, env, obsidian });

describe('isBuiltinExcluded', () => {
  it('skips dot-prefixed segments anywhere and EXCLUDED_DIRS directories', () => {
    expect(isBuiltinExcluded('.obsidian/app.json', false)).toBe(true);
    expect(isBuiltinExcluded('notes/.hidden.md', false)).toBe(true);
    expect(isBuiltinExcluded('a/node_modules/x.md', false)).toBe(true);
    expect(isBuiltinExcluded('attachments', true)).toBe(true);
    // a FILE named like an excluded dir is not excluded (matches the parser)
    expect(isBuiltinExcluded('attachments', false)).toBe(false);
    expect(isBuiltinExcluded('Projects/v1.2/note.md', false)).toBe(false);
  });
});

describe('gitignore-style rules (.obsidianbrainignore / OBSIDIAN_BRAIN_IGNORE)', () => {
  it('a folder with a space, at the root and nested; files inside it too', () => {
    const ig = rules(['Claude outputs/']);
    expect(ig.isUserExcluded('Claude outputs', true)).toBe(true);
    expect(ig.isUserExcluded('Claude outputs/a.md', false)).toBe(true);
    expect(ig.isUserExcluded('Work/Claude outputs/deep/b.md', false)).toBe(true);
    expect(ig.isUserExcluded('Claude outputs 2/a.md', false)).toBe(false);
    expect(ig.isUserExcluded('Notes/a.md', false)).toBe(false);
  });

  it('a trailing slash matches only directories', () => {
    const ig = rules(['drafts/']);
    expect(ig.isUserExcluded('drafts', true)).toBe(true);
    expect(ig.isUserExcluded('drafts', false)).toBe(false);
  });

  it('no trailing slash matches files and directories', () => {
    const ig = rules(['drafts']);
    expect(ig.isUserExcluded('drafts', true)).toBe(true);
    expect(ig.isUserExcluded('x/drafts', false)).toBe(true);
  });

  it('a leading slash anchors to the vault root', () => {
    const ig = rules(['/Archive/']);
    expect(ig.isUserExcluded('Archive/a.md', false)).toBe(true);
    expect(ig.isUserExcluded('Work/Archive/a.md', false)).toBe(false);
  });

  it('globs: **/dir/, *.ext, middle wildcard', () => {
    const ig = rules(['**/tmp/', '*.draft.md', 'Daily/2024-*']);
    expect(ig.isUserExcluded('a/b/tmp/x.md', false)).toBe(true);
    expect(ig.isUserExcluded('Idea.draft.md', false)).toBe(true);
    expect(ig.isUserExcluded('Idea.md', false)).toBe(false);
    expect(ig.isUserExcluded('Daily/2024-01-01.md', false)).toBe(true);
    expect(ig.isUserExcluded('Daily/2025-01-01.md', false)).toBe(false);
  });

  it('negation re-includes, but not under an excluded parent (git semantics)', () => {
    const ig = rules(['Inbox/*', '!Inbox/keep.md']);
    expect(ig.isUserExcluded('Inbox/other.md', false)).toBe(true);
    expect(ig.isUserExcluded('Inbox/keep.md', false)).toBe(false);
    const parent = rules(['Inbox/', '!Inbox/keep.md']);
    expect(parent.isUserExcluded('Inbox/keep.md', false)).toBe(true);
  });

  it('env rules come after file rules, so env `!pattern` overrides the file', () => {
    const ig = rules(['Private/*'], ['!Private/shared.md']);
    expect(ig.isUserExcluded('Private/secret.md', false)).toBe(true);
    expect(ig.isUserExcluded('Private/shared.md', false)).toBe(false);
  });

  it('is case-insensitive', () => {
    const ig = rules(['claude outputs/']);
    expect(ig.isUserExcluded('Claude Outputs/a.md', false)).toBe(true);
  });

  it('matches NFC and NFD spellings of the same name', () => {
    const nfd = 'Cafe\u0301'; // e + combining acute
    const nfc = 'Caf\u00e9';
    expect(rules([`${nfc}/`]).isUserExcluded(`${nfd}/a.md`, false)).toBe(true);
    expect(rules([`${nfd}/`]).isUserExcluded(`${nfc}/a.md`, false)).toBe(true);
  });

  it('emoji and CJK folder names', () => {
    const ig = rules(['🗂️ Inbox/', '日記/']);
    expect(ig.isUserExcluded('🗂️ Inbox/a.md', false)).toBe(true);
    expect(ig.isUserExcluded('日記/2024.md', false)).toBe(true);
    expect(ig.isUserExcluded('日本/2024.md', false)).toBe(false);
  });

  it('no rules → nothing excluded, empty flag set', () => {
    const ig = rules();
    expect(ig.empty).toBe(true);
    expect(ig.isUserExcluded('anything.md', false)).toBe(false);
    expect(ig.isExcluded('.obsidian', true)).toBe(true); // built-ins still apply
  });

  it('never throws on odd paths', () => {
    const ig = rules(['x/']);
    expect(ig.isUserExcluded('', false)).toBe(false);
    expect(() => ig.isUserExcluded('./weird', false)).not.toThrow();
  });
});

describe('parseIgnoreEnv', () => {
  const vault = '/Users/me/Vault';

  it('splits on commas and newlines and trims', () => {
    expect(parseIgnoreEnv(' Claude outputs/ , Templates/\nArchive/ ', vault)).toEqual([
      'Claude outputs/',
      'Templates/',
      'Archive/',
    ]);
  });

  it('accepts a JSON array so a name can contain a comma', () => {
    expect(parseIgnoreEnv('["Smith, John/", "Inbox/"]', vault)).toEqual(['Smith, John/', 'Inbox/']);
  });

  it('falls back to the list form when the value only looks like JSON', () => {
    expect(parseIgnoreEnv('[draft]/,x', vault)).toEqual(['[draft]/', 'x']);
  });

  it('empty / unset → no rules', () => {
    expect(parseIgnoreEnv(undefined, vault)).toEqual([]);
    expect(parseIgnoreEnv('  ', vault)).toEqual([]);
    expect(parseIgnoreEnv(' , ,', vault)).toEqual([]);
  });

  it('converts backslashes and anchors ./ to the root', () => {
    expect(parseIgnoreEnv('Work\\Claude outputs\\', vault)).toEqual(['Work/Claude outputs/']);
    expect(parseIgnoreEnv('./Inbox/', vault)).toEqual(['/Inbox/']);
  });

  it('keeps gitignore escapes and negation', () => {
    expect(parseIgnoreEnv('\\#notes, !keep.md', vault)).toEqual(['\\#notes', '!keep.md']);
  });

  it('turns an absolute POSIX path inside the vault into an anchored rule', () => {
    expect(parseIgnoreEnv('/Users/me/Vault/Claude outputs/', vault)).toEqual(['/Claude outputs/']);
  });

  it('turns a pasted Windows path inside the vault into an anchored rule', () => {
    const winVault = 'C:\\Users\\me\\Vault';
    expect(parseIgnoreEnv('C:\\Users\\me\\Vault\\Claude outputs', winVault, path.win32)).toEqual([
      '/Claude outputs',
    ]);
    expect(parseIgnoreEnv('c:\\users\\me\\vault\\Claude outputs\\', winVault, path.win32)).toEqual([
      '/Claude outputs/',
    ]);
  });

  it('drops absolute paths outside the vault', () => {
    expect(parseIgnoreEnv('/somewhere/else/', vault)).toEqual([]);
    expect(parseIgnoreEnv('D:\\Other', 'C:\\Vault', path.win32)).toEqual([]);
  });
});

describe("Obsidian's Excluded files (userIgnoreFilters)", () => {
  it('plain entries are path prefixes, like Obsidian', () => {
    const ig = rules([], [], ['Archive']);
    expect(ig.isUserExcluded('Archive/a.md', false)).toBe(true);
    expect(ig.isUserExcluded('Archive.md', false)).toBe(true);
    expect(ig.isUserExcluded('Archive 2/a.md', false)).toBe(true);
    expect(ig.isUserExcluded('Work/Archive/a.md', false)).toBe(false);
  });

  it('a folder entry with a trailing slash prunes the folder itself', () => {
    const ig = rules([], [], ['Archive/']);
    expect(ig.isUserExcluded('Archive', true)).toBe(true);
    expect(ig.isUserExcluded('Archive.md', false)).toBe(false);
  });

  it('/regex/ entries are regular expressions; invalid ones and #tags are skipped', () => {
    const ig = rules([], [], ['/\\.excalidraw\\.md$/', '/([/', '#private']);
    expect(ig.isUserExcluded('Drawings/a.excalidraw.md', false)).toBe(true);
    expect(ig.isUserExcluded('Drawings/a.md', false)).toBe(false);
    expect(ig.isUserExcluded('#private/a.md', false)).toBe(false);
  });
});

describe('loading rules from the vault', () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-ignore-'));
    clearVaultIgnoreCache();
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    clearVaultIgnoreCache();
    vi.useRealTimers();
  });

  it('reads .obsidianbrainignore with a BOM, CRLF endings, comments and blanks', () => {
    writeFileSync(join(vault, IGNORE_FILE_NAME), '\uFEFF# Claude Desktop output\r\nClaude outputs/\r\n\r\nTemplates/   \r\n');
    const ig = loadVaultIgnore(vault, {});
    expect(ig.rules.file).toEqual(['Claude outputs/', 'Templates/']);
    expect(ig.isUserExcluded('Templates/t.md', false)).toBe(true);
  });

  it('keeps an escaped trailing space (git semantics)', () => {
    writeFileSync(join(vault, IGNORE_FILE_NAME), 'Trailing\\ \nPlain   \n');
    const ig = loadVaultIgnore(vault, {});
    expect(ig.rules.file).toEqual(['Trailing\\ ', 'Plain']);
    expect(ig.isUserExcluded('Trailing ', true)).toBe(true);
    expect(ig.isUserExcluded('Plain', true)).toBe(true);
  });

  it('reads the env var', () => {
    const ig = loadVaultIgnore(vault, { [IGNORE_ENV]: 'Inbox/' });
    expect(ig.rules.env).toEqual(['Inbox/']);
    expect(ig.isUserExcluded('Inbox/a.md', false)).toBe(true);
  });

  it("ignores Obsidian's Excluded files unless the opt-in is set", () => {
    mkdirSync(join(vault, '.obsidian'));
    writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({ userIgnoreFilters: ['Archive/'] }));
    expect(loadVaultIgnore(vault, {}).isUserExcluded('Archive/a.md', false)).toBe(false);
    expect(
      loadVaultIgnore(vault, { [HONOR_EXCLUDED_FILES_ENV]: 'true' }).isUserExcluded('Archive/a.md', false),
    ).toBe(true);
    expect(loadVaultIgnore(vault, { [HONOR_EXCLUDED_FILES_ENV]: '0' }).rules.obsidian).toEqual([]);
  });

  it('tolerates a missing, keyless or malformed app.json', () => {
    expect(readObsidianExcludedFiles(vault)).toEqual([]);
    mkdirSync(join(vault, '.obsidian'));
    writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({ alwaysUpdateLinks: true }));
    expect(readObsidianExcludedFiles(vault)).toEqual([]);
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{not json');
    expect(readObsidianExcludedFiles(vault)).toEqual([]);
  });

  it('getVaultIgnore picks up an edited ignore file without a restart', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(getVaultIgnore(vault, {}).empty).toBe(true);
    writeFileSync(join(vault, IGNORE_FILE_NAME), 'Inbox/\n');
    // Within the re-check window the cached matcher is reused …
    expect(getVaultIgnore(vault, {}).empty).toBe(true);
    // … and after it, the change is seen.
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect(getVaultIgnore(vault, {}).isUserExcluded('Inbox/a.md', false)).toBe(true);
  });

  it('getVaultIgnore reuses the same matcher while nothing changes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    writeFileSync(join(vault, IGNORE_FILE_NAME), 'Inbox/\n');
    const a = getVaultIgnore(vault, {});
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    expect(getVaultIgnore(vault, {})).toBe(a);
  });
});
