import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editNote, type EditMode } from '../../src/vault/editor.js';

let vault: string;
const rel = 'note.md';

async function seed(initial: string): Promise<void> {
  vault = await mkdtemp(join(tmpdir(), 'kg-editor-'));
  await writeFile(join(vault, rel), initial, 'utf-8');
}

const edit = (mode: EditMode) => editNote(vault, rel, mode);
const read = () => readFile(join(vault, rel), 'utf-8');

afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe('editor - append / prepend', () => {
  beforeEach(async () => seed('hello\n'));

  it('append: adds content to end of file', async () => {
    const r = await edit({ kind: 'append', content: 'world\n' });
    expect(r.bytesWritten).toBeGreaterThan(0);
    expect(await read()).toBe('hello\nworld\n');
  });

  it('prepend: adds content to start of file', async () => {
    await edit({ kind: 'prepend', content: 'intro\n' });
    expect(await read()).toBe('intro\nhello\n');
  });
});

describe('editor - prepend with frontmatter (F4)', () => {
  it('inserts content after the closing --- of a YAML frontmatter block', async () => {
    await seed('---\ntitle: foo\n---\n# Heading\nbody\n');
    await edit({ kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await read()).toBe(
      '---\ntitle: foo\n---\n<!-- banner -->\n# Heading\nbody\n',
    );
  });

  it('falls back to position 0 when no frontmatter is present', async () => {
    await seed('# Heading\nbody\n');
    await edit({ kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await read()).toBe('<!-- banner -->\n# Heading\nbody\n');
  });

  it('falls back to position 0 for malformed frontmatter (missing close)', async () => {
    await seed('---\ntitle: foo\n# Heading\nbody\n');
    await edit({ kind: 'prepend', content: '<!-- banner -->\n' });
    expect(await read()).toBe(
      '<!-- banner -->\n---\ntitle: foo\n# Heading\nbody\n',
    );
  });
});

describe('editor - replace_window', () => {
  beforeEach(async () => seed('foo bar baz\nmore text here\n'));

  it('exact: replaces a unique substring', async () => {
    await edit({ kind: 'replace_window', search: 'bar', content: 'QUX' });
    expect(await read()).toBe('foo QUX baz\nmore text here\n');
  });

  it('exact: NoMatch when search is missing', async () => {
    await expect(
      edit({ kind: 'replace_window', search: 'nonexistent', content: 'X' }),
    ).rejects.toThrow(/NoMatch/);
  });

  it('exact: MultipleMatches when search matches more than once', async () => {
    await writeFile(join(vault, rel), 'dup dup dup\n', 'utf-8');
    await expect(
      edit({ kind: 'replace_window', search: 'dup', content: 'X' }),
    ).rejects.toThrow(/MultipleMatches/);
  });

  it('fuzzy: replaces a near-match above threshold', async () => {
    await writeFile(join(vault, rel), 'The quick brown fox jumps.\n', 'utf-8');
    await edit({
      kind: 'replace_window',
      search: 'quikc brown',
      content: 'nimble red',
      fuzzy: true,
    });
    const after = await read();
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
    await edit({
      kind: 'replace_window',
      search: 'original content under SECTION b',
      content: 'Section B content was replaced via FUZZY replace_window.',
      fuzzy: true,
    });
    const after = await read();
    expect(after).toBe(
      'Section B content was replaced via FUZZY replace_window.\n',
    );
    expect(after).not.toMatch(/\.\./);
  });
});

describe('editor - patch_heading', () => {
  const initial = [
    '# Root', '', '## Alpha', 'alpha body line 1', 'alpha body line 2',
    '', '## Beta', 'beta body', '',
  ].join('\n');

  beforeEach(async () => seed(initial));

  it('replace: swaps the body under the heading', async () => {
    await edit({
      kind: 'patch_heading', heading: 'Alpha',
      content: 'new alpha body', op: 'replace',
    });
    const after = await read();
    expect(after).toContain('## Alpha\nnew alpha body\n');
    expect(after).toContain('## Beta');
  });

  it('after: inserts content right below the heading', async () => {
    await edit({
      kind: 'patch_heading', heading: 'Alpha',
      content: 'INSERTED AFTER', op: 'after',
    });
    const after = await read();
    expect(after).toMatch(/## Alpha\nINSERTED AFTER\n/);
    expect(after).toContain('alpha body line 1');
  });

  it('before: inserts content directly above the heading', async () => {
    await edit({
      kind: 'patch_heading', heading: 'Beta',
      content: 'INSERTED BEFORE', op: 'before',
    });
    expect(await read()).toMatch(/INSERTED BEFORE\n## Beta/);
  });

  it('throws when heading is missing', async () => {
    await expect(
      edit({ kind: 'patch_heading', heading: 'Missing', content: 'x' }),
    ).rejects.toThrow(/Heading not found/);
  });
});

describe('editor - patch_frontmatter', () => {
  beforeEach(async () => seed('---\ntitle: Test\ntags: [a]\n---\n\nBody content.\n'));

  it('set: writes a new key into frontmatter', async () => {
    await edit({ kind: 'patch_frontmatter', key: 'status', value: 'active' });
    const after = await read();
    expect(after).toContain('status: active');
    expect(after).toContain('Body content.');
  });

  it('clear: removes a key when value is null', async () => {
    await edit({ kind: 'patch_frontmatter', key: 'tags', value: null });
    const after = await read();
    expect(after).not.toContain('tags:');
    expect(after).toContain('title: Test');
  });
});

describe('editor - at_line', () => {
  beforeEach(async () => seed('line1\nline2\nline3\n'));

  it('before: inserts above the target line', async () => {
    await edit({ kind: 'at_line', line: 2, content: 'INSERTED', op: 'before' });
    const lines = (await read()).split('\n');
    expect(lines[1]).toBe('INSERTED');
    expect(lines[2]).toBe('line2');
  });

  it('after: inserts below the target line', async () => {
    await edit({ kind: 'at_line', line: 2, content: 'INSERTED', op: 'after' });
    const lines = (await read()).split('\n');
    expect(lines[1]).toBe('line2');
    expect(lines[2]).toBe('INSERTED');
  });

  it('replace: replaces the target line', async () => {
    await edit({ kind: 'at_line', line: 2, content: 'REPLACED', op: 'replace' });
    const lines = (await read()).split('\n');
    expect(lines[1]).toBe('REPLACED');
  });

  it('throws on out-of-range line', async () => {
    await expect(
      edit({ kind: 'at_line', line: 999, content: 'x' }),
    ).rejects.toThrow(/Invalid line/);
  });
});

