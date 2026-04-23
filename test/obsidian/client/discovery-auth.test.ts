import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObsidianClient } from '../../../src/obsidian/client.js';
import { PluginUnavailableError } from '../../../src/obsidian/errors.js';
import { portOf, startServer, writeDiscovery } from './helpers.js';

/**
 * Discovery-file reading and transport-layer auth. Everything that has to
 * work before any endpoint logic runs.
 */
describe.sequential('ObsidianClient — discovery & auth', () => {
  let vault: string;
  let server: Server | null = null;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-client-test-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    rmSync(vault, { recursive: true, force: true });
  });

  it('throws PluginUnavailableError when discovery is missing', async () => {
    const client = new ObsidianClient(vault);
    await expect(client.status()).rejects.toBeInstanceOf(PluginUnavailableError);
  });

  it('hits /status with correct bearer auth', async () => {
    server = await startServer('tok-1', () => ({
      status: 200,
      body: {
        ok: true,
        pluginId: 'obsidian-brain-companion',
        pluginVersion: '0.1.0',
        vaultName: 'test',
        readyAt: 1,
      },
    }));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok-1' });

    const client = new ObsidianClient(vault);
    const res = await client.status();
    expect(res.ok).toBe(true);
    expect(res.pluginId).toBe('obsidian-brain-companion');
  });

  it('re-reads discovery + retries on 401 (rotated token)', async () => {
    // First discovery has a stale token. After we rewrite, the second call
    // retries and succeeds.
    server = await startServer('tok-new', () => ({
      status: 200,
      body: { active: { path: 'note.md', basename: 'note', extension: 'md' } },
    }));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok-stale' });

    const client = new ObsidianClient(vault);
    // First call: stale token → 401 → retry → still stale because discovery
    // hasn't changed yet → final throw.
    await expect(client.active()).rejects.toBeInstanceOf(PluginUnavailableError);

    // Rewrite discovery with the fresh token — next call should succeed.
    writeDiscovery(vault, { port, token: 'tok-new' });
    const res = await client.active();
    expect(res.active?.path).toBe('note.md');
  });

  it('throws PluginUnavailableError when HTTP endpoint is unreachable', async () => {
    writeDiscovery(vault, { port: 59999, token: 'whatever' });
    const client = new ObsidianClient(vault);
    await expect(client.status()).rejects.toBeInstanceOf(PluginUnavailableError);
  });
});
