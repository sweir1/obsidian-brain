import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import matter from 'gray-matter';
import { editAt, readAt, seedVault } from './helpers.js';

let vault: string;

afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe('editor - patch_frontmatter', () => {
  beforeEach(async () => {
    vault = await seedVault('---\ntitle: Test\ntags: [a]\n---\n\nBody content.\n');
  });

  it('set: writes a new key into frontmatter', async () => {
    await editAt(vault, { kind: 'patch_frontmatter', key: 'status', value: 'active' });
    const after = await readAt(vault);
    expect(after).toContain('status: active');
    expect(after).toContain('Body content.');
  });

  it('clear: removes a key when value is null', async () => {
    await editAt(vault, { kind: 'patch_frontmatter', key: 'tags', value: null });
    const after = await readAt(vault);
    expect(after).not.toContain('tags:');
    expect(after).toContain('title: Test');
  });
});

// patchFrontmatter round-trips through gray-matter, which re-serialises the
// YAML on every write. These tests pin the round-trip invariant for the
// non-scalar value shapes the editor is expected to preserve (arrays, nested
// objects), plus the overwrite/insert-when-no-fm/clear-nonexistent edges the
// original two-case suite never touched.
describe('editor - patch_frontmatter rigor', () => {
  let vault: string;

  afterEach(async () => {
    if (vault) await rm(vault, { recursive: true, force: true });
  });

  it('array value round-trips as a YAML array', async () => {
    vault = await seedVault('---\ntitle: Test\n---\n\nBody.\n');
    await editAt(vault, {
      kind: 'patch_frontmatter',
      key: 'tags',
      value: ['alpha', 'beta', 'gamma'],
    });
    const after = await readAt(vault);
    const parsed = matter(after);
    expect(parsed.data.tags).toEqual(['alpha', 'beta', 'gamma']);
    expect(parsed.content.trim()).toBe('Body.');
  });

  it('nested object value round-trips preserving structure', async () => {
    vault = await seedVault('---\ntitle: Test\n---\n\nBody.\n');
    await editAt(vault, {
      kind: 'patch_frontmatter',
      key: 'meta',
      value: { source: 'imported', stats: { count: 3, depth: 2 } },
    });
    const parsed = matter(await readAt(vault));
    expect(parsed.data.meta).toEqual({ source: 'imported', stats: { count: 3, depth: 2 } });
  });

  it('update: overwrites an existing key, leaves others untouched', async () => {
    vault = await seedVault('---\ntitle: Old\ntags: [keep]\n---\n\nBody.\n');
    await editAt(vault, { kind: 'patch_frontmatter', key: 'title', value: 'New' });
    const parsed = matter(await readAt(vault));
    expect(parsed.data.title).toBe('New');
    expect(parsed.data.tags).toEqual(['keep']);
  });

  it('insert: adds frontmatter block to a file that has none', async () => {
    vault = await seedVault('Just body, no frontmatter.\n');
    await editAt(vault, { kind: 'patch_frontmatter', key: 'status', value: 'draft' });
    const after = await readAt(vault);
    expect(after.startsWith('---\n')).toBe(true);
    const parsed = matter(after);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.content.trim()).toBe('Just body, no frontmatter.');
  });

  it('clear: removing a non-existent key preserves existing fm and body', async () => {
    vault = await seedVault('---\ntitle: Test\n---\n\nBody.\n');
    await editAt(vault, { kind: 'patch_frontmatter', key: 'never_existed', value: null });
    const parsed = matter(await readAt(vault));
    expect(parsed.data.title).toBe('Test');
    expect(parsed.content.trim()).toBe('Body.');
  });

  it('value: undefined also clears the key', async () => {
    vault = await seedVault('---\ntitle: Test\ntags: [a]\n---\n\nBody.\n');
    await editAt(vault, { kind: 'patch_frontmatter', key: 'tags', value: undefined });
    const parsed = matter(await readAt(vault));
    expect(parsed.data.tags).toBeUndefined();
    expect(parsed.data.title).toBe('Test');
  });

  it('body content is not mutated when only frontmatter changes', async () => {
    const body = '\nParagraph 1 with **bold** and [link](x).\n\n- list item\n- another\n';
    vault = await seedVault(`---\ntitle: Test\n---${body}`);
    await editAt(vault, { kind: 'patch_frontmatter', key: 'status', value: 'active' });
    const parsed = matter(await readAt(vault));
    // gray-matter's `.content` strips the leading newline that separates
    // the frontmatter block from the body, so compare the trimmed body.
    expect(parsed.content.replace(/^\n/, '')).toBe(body.replace(/^\n/, ''));
  });
});
