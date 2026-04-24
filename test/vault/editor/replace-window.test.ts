import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { editNote } from '../../../src/vault/editor.js';
import { editAt, readAt, rel, seedVault } from './helpers.js';

let vault: string;

afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe('editor - replace_window', () => {
  beforeEach(async () => {
    vault = await seedVault('foo bar baz\nmore text here\n');
  });

  it('exact: replaces a unique substring', async () => {
    await editAt(vault, { kind: 'replace_window', search: 'bar', content: 'QUX' });
    expect(await readAt(vault)).toBe('foo QUX baz\nmore text here\n');
  });

  it('exact: NoMatch when search is missing', async () => {
    await expect(
      editAt(vault, { kind: 'replace_window', search: 'nonexistent', content: 'X' }),
    ).rejects.toThrow(/NoMatch/);
  });

  it('exact: MultipleMatches when search matches more than once', async () => {
    await writeFile(join(vault, rel), 'dup dup dup\n', 'utf-8');
    await expect(
      editAt(vault, { kind: 'replace_window', search: 'dup', content: 'X' }),
    ).rejects.toThrow(/MultipleMatches/);
  });

  it('fuzzy: replaces a near-match above threshold', async () => {
    await writeFile(join(vault, rel), 'The quick brown fox jumps.\n', 'utf-8');
    await editAt(vault, {
      kind: 'replace_window',
      search: 'quikc brown',
      content: 'nimble red',
      fuzzy: true,
    });
    const after = await readAt(vault);
    expect(after).toContain('nimble red');
    expect(after).not.toContain('quick brown');
  });

  it('fuzzy: subsumes trailing sentence punctuation to avoid doubles (F6)', async () => {
    // Reproduces the v1.2.0 bug: search text had no trailing punctuation but
    // the match in the file ended with ".", and the replacement already
    // ended in ".", producing a double period.
    await writeFile(
      join(vault, rel),
      'Original content under section B.\n',
      'utf-8',
    );
    await editAt(vault, {
      kind: 'replace_window',
      search: 'original content under SECTION b',
      content: 'Section B content was replaced via FUZZY replace_window.',
      fuzzy: true,
    });
    const after = await readAt(vault);
    expect(after).toBe(
      'Section B content was replaced via FUZZY replace_window.\n',
    );
    expect(after).not.toMatch(/\.\./);
  });
});

describe('replace_window fuzzy threshold', () => {
  // "The quick brown fox" — needle "quikk bworn" is a degraded version with
  // two substitutions across 11 chars: similarity ≈ 1 - 2/11 ≈ 0.82.
  const haystackStrict = 'The quick brown fox jumped.\n';
  const needleStrict = 'quikk bworn';

  // See original file for the similarity calculations behind these.
  const haystackLoose = 'Few small steps taken now.\n';
  const needleLoose = 'fw sml stps tkn';

  beforeEach(async () => {
    vault = await seedVault(haystackStrict);
  });

  it('uses fuzzyThreshold=0.9 when provided and rejects matches below it', async () => {
    // needleStrict scores ~0.82 — passes default 0.7 but should fail at 0.9.
    await writeFile(join(vault, rel), haystackStrict, 'utf-8');
    await expect(
      editAt(vault, {
        kind: 'replace_window',
        search: needleStrict,
        content: 'REPLACED',
        fuzzy: true,
        fuzzyThreshold: 0.95,
      }),
    ).rejects.toThrow(/NoMatch/);
  });

  it('uses fuzzyThreshold=0.3 when provided and accepts weaker matches than default', async () => {
    // needleLoose scores below 0.7 (fails default) but well above 0.3.
    await writeFile(join(vault, rel), haystackLoose, 'utf-8');
    await editAt(vault, {
      kind: 'replace_window',
      search: needleLoose,
      content: 'REPLACED',
      fuzzy: true,
      fuzzyThreshold: 0.3,
    });
    expect(await readAt(vault)).toContain('REPLACED');
  });

  it('defaults to 0.7 when fuzzyThreshold is not provided (backward compat)', async () => {
    // needleStrict ~0.82 should match under the 0.7 default.
    await writeFile(join(vault, rel), haystackStrict, 'utf-8');
    await editAt(vault, {
      kind: 'replace_window',
      search: needleStrict,
      content: 'REPLACED',
      fuzzy: true,
    });
    expect(await readAt(vault)).toContain('REPLACED');
  });
});

// The exact-path slice in replaceWindow uses JS string indices (UTF-16 code
// units) while `removedLen` is reported as UTF-8 bytes. Both are intentional:
// slicing on JS indices is internally consistent, and `bytesWritten` /
// `removedLen` live in the same byte-denominated world. These tests lock in
// that contract — if someone ever "fixes" removedLen to `search.length` on
// the (wrong) assumption that bytes == code units, they fail.
describe('replace_window - UTF-8 / multibyte content', () => {
  beforeEach(async () => {
    vault = await seedVault('seed\n');
  });

  it('exact: replaces a needle containing a 4-byte emoji', async () => {
    await writeFile(join(vault, rel), 'Hello 🎉 world\n', 'utf-8');
    const result = await editNote(vault, rel, {
      kind: 'replace_window',
      search: 'Hello 🎉 world',
      content: 'Hi there',
    });
    expect(await readAt(vault)).toBe('Hi there\n');
    // 'Hello ' (6) + '🎉' (4 bytes UTF-8) + ' world' (6) = 16 bytes.
    expect(result.removedLen).toBe(16);
  });

  it('exact: replaces a needle containing accented chars (2-byte é)', async () => {
    await writeFile(join(vault, rel), 'café con leche\n', 'utf-8');
    const result = await editNote(vault, rel, {
      kind: 'replace_window',
      search: 'café',
      content: 'tea',
    });
    expect(await readAt(vault)).toBe('tea con leche\n');
    // 'c' + 'a' + 'f' + 'é' (2 bytes) = 5 bytes.
    expect(result.removedLen).toBe(5);
  });

  it('exact: regex metacharacters in search are treated literally, not as regex', async () => {
    // If the exact path ever accidentally switched to RegExp-based matching,
    // `.*+?` would match everything. The contract is literal substring match.
    await writeFile(join(vault, rel), 'before (.*+?) after\n', 'utf-8');
    await editNote(vault, rel, {
      kind: 'replace_window',
      search: '(.*+?)',
      content: 'LITERAL',
    });
    expect(await readAt(vault)).toBe('before LITERAL after\n');
  });

  it('exact: search starting at file offset 0 replaces correctly', async () => {
    await writeFile(join(vault, rel), 'START then middle then end\n', 'utf-8');
    await editNote(vault, rel, {
      kind: 'replace_window',
      search: 'START',
      content: 'BEGIN',
    });
    expect(await readAt(vault)).toBe('BEGIN then middle then end\n');
  });
});
