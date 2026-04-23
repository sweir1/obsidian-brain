import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
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
