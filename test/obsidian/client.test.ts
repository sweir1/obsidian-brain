import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObsidianClient } from '../../src/obsidian/client.js';
import { PluginUnavailableError } from '../../src/obsidian/errors.js';

function writeDiscovery(
  vault: string,
  record: {
    port: number;
    token: string;
    pid?: number;
    pluginVersion?: string;
    startedAt?: number;
  },
): void {
  const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'discovery.json'),
    JSON.stringify({
      pid: 1,
      pluginVersion: '0.1.0',
      startedAt: Date.now(),
      ...record,
    }),
  );
}

function startServer(
  token: string,
  handler: (method: string, path: string) => {
    status: number;
    body: unknown;
  },
): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const r = handler(req.method ?? 'GET', req.url ?? '/');
      res.statusCode = r.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.body));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function portOf(s: Server): Promise<number> {
  const addr = s.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('no port');
}

describe.sequential('ObsidianClient', () => {
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
    // should retry and succeed.
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
    // Point discovery at a port that isn't listening.
    writeDiscovery(vault, { port: 59999, token: 'whatever' });
    const client = new ObsidianClient(vault);
    await expect(client.status()).rejects.toBeInstanceOf(PluginUnavailableError);
  });
});
