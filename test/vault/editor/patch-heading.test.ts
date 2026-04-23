import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { MultipleMatchesError } from '../../../src/vault/editor.js';
import { editAt, readAt, seedVault } from './helpers.js';

let vault: string;

afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe('editor - patch_heading', () => {
  const initial = [
    '# Root', '', '## Alpha', 'alpha body line 1', 'alpha body line 2',
    '', '## Beta', 'beta body', '',
  ].join('\n');

  beforeEach(async () => {
    vault = await seedVault(initial);
  });

  it('replace: swaps the body under the heading', async () => {
    await editAt(vault, {
      kind: 'patch_heading', heading: 'Alpha',
      content: 'new alpha body', op: 'replace',
    });
    const after = await readAt(vault);
    expect(after).toContain('## Alpha\nnew alpha body\n');
    expect(after).toContain('## Beta');
  });

  it('after: inserts content right below the heading', async () => {
    await editAt(vault, {
      kind: 'patch_heading', heading: 'Alpha',
      content: 'INSERTED AFTER', op: 'after',
    });
    const after = await readAt(vault);
    expect(after).toMatch(/## Alpha\nINSERTED AFTER\n/);
    expect(after).toContain('alpha body line 1');
  });

  it('before: inserts content directly above the heading', async () => {
    await editAt(vault, {
      kind: 'patch_heading', heading: 'Beta',
      content: 'INSERTED BEFORE', op: 'before',
    });
    expect(await readAt(vault)).toMatch(/INSERTED BEFORE\n## Beta/);
  });

  it('throws when heading is missing', async () => {
    await expect(
      editAt(vault, { kind: 'patch_heading', heading: 'Missing', content: 'x' }),
    ).rejects.toThrow(/Heading not found/);
  });
});

describe('editor - patch_heading multi-match (H2/L3)', () => {
  const initial = [
    '# Root', '', '## Notes', 'first notes body', '',
    '## Other', 'other body', '',
    '## Notes', 'second notes body', '',
  ].join('\n');

  beforeEach(async () => {
    vault = await seedVault(initial);
  });

  it('throws MultipleMatchesError on duplicate headings, listing line numbers', async () => {
    await expect(
      editAt(vault, { kind: 'patch_heading', heading: 'Notes', content: 'x' }),
    ).rejects.toThrow(MultipleMatchesError);

    try {
      await editAt(vault, { kind: 'patch_heading', heading: 'Notes', content: 'x' });
    } catch (err) {
      expect(err).toBeInstanceOf(MultipleMatchesError);
      const mme = err as MultipleMatchesError;
      expect(mme.matches).toHaveLength(2);
      expect(mme.matches[0].line).toBe(3);
      expect(mme.matches[1].line).toBe(9);
      expect(mme.message).toMatch(/pass headingIndex/);
      expect(mme.message).toMatch(/\[3\]/);
      expect(mme.message).toMatch(/\[9\]/);
    }
  });

  it('headingIndex: 0 picks the first occurrence', async () => {
    await editAt(vault, {
      kind: 'patch_heading',
      heading: 'Notes',
      content: 'PATCHED FIRST',
      headingIndex: 0,
    });
    const after = await readAt(vault);
    expect(after).toContain('## Notes\nPATCHED FIRST\n');
    expect(after).toContain('second notes body');
  });

  it('headingIndex: 1 picks the second occurrence', async () => {
    await editAt(vault, {
      kind: 'patch_heading',
      heading: 'Notes',
      content: 'PATCHED SECOND',
      headingIndex: 1,
    });
    const after = await readAt(vault);
    expect(after).toContain('first notes body');
    expect(after).toContain('## Notes\nPATCHED SECOND');
    expect(after).not.toContain('second notes body');
  });

  it('throws when headingIndex is out of range', async () => {
    await expect(
      editAt(vault, {
        kind: 'patch_heading',
        heading: 'Notes',
        content: 'x',
        headingIndex: 5,
      }),
    ).rejects.toThrow(/headingIndex=5 out of range/);
  });

  it('ignores headingIndex when only one heading matches', async () => {
    await editAt(vault, {
      kind: 'patch_heading',
      heading: 'Other',
      content: 'ONE AND ONLY',
      headingIndex: 0,
    });
    expect(await readAt(vault)).toContain('## Other\nONE AND ONLY\n');
  });
});
