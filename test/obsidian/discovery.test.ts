import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDiscovery, discoveryFilePath } from '../../src/obsidian/discovery.js';

describe('obsidian/discovery', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-discovery-test-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns null when the discovery file is absent', async () => {
    expect(await readDiscovery(vault)).toBeNull();
  });

  it('parses a valid discovery file (v0.2.0+: reads capabilities list)', async () => {
    const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'discovery.json'),
      JSON.stringify({
        port: 27125,
        token: 'deadbeef',
        pid: 42,
        pluginVersion: '0.2.0',
        startedAt: 1700000000000,
        capabilities: ['status', 'active', 'dataview'],
      }),
    );

    const result = await readDiscovery(vault);
    expect(result).toEqual({
      port: 27125,
      token: 'deadbeef',
      pid: 42,
      pluginVersion: '0.2.0',
      startedAt: 1700000000000,
      capabilities: ['status', 'active', 'dataview'],
    });
  });

  it('backfills legacy capabilities when the field is absent (v0.1.x plugins)', async () => {
    const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'discovery.json'),
      JSON.stringify({
        port: 27125,
        token: 'deadbeef',
        pid: 42,
        pluginVersion: '0.1.0',
        startedAt: 1700000000000,
      }),
    );

    const result = await readDiscovery(vault);
    expect(result?.capabilities).toEqual(['status', 'active']);
  });

  it('returns null for malformed JSON', async () => {
    const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'discovery.json'), '{not json');
    expect(await readDiscovery(vault)).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'discovery.json'), JSON.stringify({ port: 27125 }));
    expect(await readDiscovery(vault)).toBeNull();
  });

  it('exposes the expected file path', () => {
    expect(discoveryFilePath('/tmp/vault')).toBe(
      '/tmp/vault/.obsidian/plugins/obsidian-brain-companion/discovery.json',
    );
  });
});
