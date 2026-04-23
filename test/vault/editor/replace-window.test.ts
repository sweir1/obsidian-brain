import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
