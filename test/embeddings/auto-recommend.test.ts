/**
 * Unit tests for src/embeddings/auto-recommend.ts
 *
 * Uses a real temp directory to avoid complex fs mocking.
 * No network calls are made.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recommendPreset } from '../../src/embeddings/auto-recommend.js';

// ---------------------------------------------------------------------------
// Test vault helpers
// ---------------------------------------------------------------------------

function makeVault(
  base: string,
  files: { name: string; content: string }[],
): string {
  mkdirSync(base, { recursive: true });
  for (const { name, content } of files) {
    writeFileSync(join(base, name), content, 'utf8');
  }
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recommendPreset', () => {
  const baseDir = join(tmpdir(), 'obs-auto-recommend-test-' + Date.now());

  afterAll(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('recommends english for an ASCII-only vault', async () => {
    const vaultPath = makeVault(join(baseDir, 'english-vault'), [
      { name: 'note1.md', content: 'Hello world. This is a test note.' },
      { name: 'note2.md', content: 'Another note with English content only.' },
    ]);

    const result = await recommendPreset(vaultPath);

    expect(result.preset).toBe('english');
    expect(result.model).toBe('Xenova/bge-small-en-v1.5');
    expect(result.rationale).toMatch(/english/i);
  });

  it('recommends multilingual for a vault with >5% non-ASCII characters', async () => {
    // Japanese content is almost entirely non-ASCII.
    const japaneseContent = 'これはテストノートです。知識グラフのテスト。'.repeat(50);
    const vaultPath = makeVault(join(baseDir, 'multilingual-vault'), [
      { name: 'note1.md', content: japaneseContent },
      { name: 'note2.md', content: japaneseContent },
    ]);

    const result = await recommendPreset(vaultPath);

    expect(result.preset).toBe('multilingual');
    expect(result.model).toBe('Xenova/multilingual-e5-small');
    expect(result.rationale).toMatch(/multilingual/i);
    expect(result.rationale).toMatch(/non-ASCII/i);
  });

  it('recommends english for empty vault', async () => {
    const vaultPath = makeVault(join(baseDir, 'empty-vault'), []);

    const result = await recommendPreset(vaultPath);

    expect(result.preset).toBe('english');
    expect(result.rationale).toMatch(/empty|no markdown/i);
  });

  it('skips hidden directories (e.g. .obsidian)', async () => {
    const vaultPath = join(baseDir, 'vault-with-hidden');
    mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
    writeFileSync(join(vaultPath, '.obsidian', 'config.md'), 'hidden', 'utf8');
    writeFileSync(join(vaultPath, 'note.md'), 'Normal English note.', 'utf8');

    const result = await recommendPreset(vaultPath);

    // Should process only note.md (English), not .obsidian/config.md.
    expect(result.preset).toBe('english');
  });

  it('returns result with all required fields', async () => {
    const vaultPath = makeVault(join(baseDir, 'fields-vault'), [
      { name: 'note.md', content: 'Some content.' },
    ]);

    const result = await recommendPreset(vaultPath);

    expect(result).toHaveProperty('preset');
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('rationale');
    expect(typeof result.preset).toBe('string');
    expect(typeof result.model).toBe('string');
    expect(typeof result.rationale).toBe('string');
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it('includes file count in rationale', async () => {
    const vaultPath = makeVault(join(baseDir, 'count-vault'), [
      { name: 'a.md', content: 'File A' },
      { name: 'b.md', content: 'File B' },
    ]);

    const result = await recommendPreset(vaultPath);

    // Rationale should mention how many files were sampled.
    expect(result.rationale).toMatch(/\d+\s+(file|Sampled)/i);
  });

  it('handles vault with mixed ASCII and non-ASCII below threshold', async () => {
    // ~2% non-ASCII: a few Chinese characters in an otherwise English note.
    const content = 'This is an English note. ' + '中'.repeat(2) + ' ' + 'A'.repeat(100);
    const vaultPath = makeVault(join(baseDir, 'mixed-below-threshold'), [
      { name: 'note.md', content },
    ]);

    const result = await recommendPreset(vaultPath);

    expect(result.preset).toBe('english');
  });
});
