import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { editAt, readAt, rel, seedVault } from './helpers.js';

let vault: string;

afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe('editor - append / prepend', () => {
  beforeEach(async () => {
    vault = await seedVault('hello\n');
  });

  it('append: adds content to end of file', async () => {
    const r = await editAt(vault, { kind: 'append', content: 'world\n' });
    expect(r.bytesWritten).toBeGreaterThan(0);
    expect(await readAt(vault)).toBe('hello\nworld\n');
  });

  it('prepend: adds content to start of file', async () => {
    await editAt(vault, { kind: 'prepend', content: 'intro\n' });
    expect(await readAt(vault)).toBe('intro\nhello\n');
  });
});

describe('editor - prepend with frontmatter (F4)', () => {
  it('inserts content after the closing --- of a YAML frontmatter block', async () => {
    vault = await seedVault('---\ntitle: foo\n---\n# Heading\nbody\n');
    await editAt(vault, { kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await readAt(vault)).toBe(
      '---\ntitle: foo\n---\n<!-- banner -->\n# Heading\nbody\n',
    );
  });

  it('falls back to position 0 when no frontmatter is present', async () => {
    vault = await seedVault('# Heading\nbody\n');
    await editAt(vault, { kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await readAt(vault)).toBe('<!-- banner -->\n# Heading\nbody\n');
  });

  it('falls back to position 0 for malformed frontmatter (missing close)', async () => {
    vault = await seedVault('---\ntitle: foo\n# Heading\nbody\n');
    await editAt(vault, { kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await readAt(vault)).toBe(
      '<!-- banner -->\n---\ntitle: foo\n# Heading\nbody\n',
    );
  });
});

describe('editor - at_line', () => {
  beforeEach(async () => {
    vault = await seedVault('line1\nline2\nline3\n');
  });

  it('before: inserts above the target line', async () => {
    await editAt(vault, { kind: 'at_line', line: 2, content: 'INSERTED', op: 'before' });
    const lines = (await readAt(vault)).split('\n');
    expect(lines[1]).toBe('INSERTED');
    expect(lines[2]).toBe('line2');
  });

  it('after: inserts below the target line', async () => {
    await editAt(vault, { kind: 'at_line', line: 2, content: 'INSERTED', op: 'after' });
    const lines = (await readAt(vault)).split('\n');
    expect(lines[1]).toBe('line2');
    expect(lines[2]).toBe('INSERTED');
  });

  it('replace: replaces the target line', async () => {
    await editAt(vault, { kind: 'at_line', line: 2, content: 'REPLACED', op: 'replace' });
    const lines = (await readAt(vault)).split('\n');
    expect(lines[1]).toBe('REPLACED');
  });

  it('throws on out-of-range line', async () => {
    await expect(
      editAt(vault, { kind: 'at_line', line: 999, content: 'x' }),
    ).rejects.toThrow(/Invalid line/);
  });
});

// Reference to rel to keep the import used if future refactors drop direct writeFile calls.
void [writeFile, join, rel];
