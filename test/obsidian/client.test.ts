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
    capabilities?: string[];
  },
): void {
  const dir = join(vault, '.obsidian', 'plugins', 'obsidian-brain-companion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'discovery.json'),
    JSON.stringify({
      pid: 1,
      pluginVersion: '0.2.0',
      startedAt: Date.now(),
      capabilities: ['status', 'active', 'dataview'],
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

  it('has() returns true for a capability advertised in discovery', async () => {
    server = await startServer('tok', () => ({ status: 200, body: {} }));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active', 'dataview'],
    });
    const client = new ObsidianClient(vault);
    expect(await client.has('dataview')).toBe(true);
    expect(await client.has('bases')).toBe(false);
  });

  it('dataview() rejects fast when the plugin lacks the dataview capability', async () => {
    server = await startServer('tok', () => ({ status: 200, body: {} }));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active'],
      pluginVersion: '0.1.0',
    });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('TABLE file.name', undefined, 5000)).rejects.toThrow(
      /0\.2\.0 or later/,
    );
  });

  it('dataview() parses a normalized table payload over HTTP', async () => {
    let receivedBody = '';
    server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer tok') {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            kind: 'table',
            headers: ['file.name', 'rating'],
            rows: [['Book A', 5]],
          }),
        );
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    const out = await client.dataview('TABLE file.name, rating FROM #book', undefined, 5000);
    expect(out).toEqual({
      kind: 'table',
      headers: ['file.name', 'rating'],
      rows: [['Book A', 5]],
    });
    expect(JSON.parse(receivedBody)).toEqual({
      query: 'TABLE file.name, rating FROM #book',
      source: undefined,
    });
  });

  it('dataview() surfaces a 424 as PluginUnavailableError with remediation text', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'dataview_not_installed',
          message:
            'The Dataview community plugin is not installed or not enabled in this vault. Install it from Settings → Community plugins and retry.',
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('TABLE file.name', undefined, 5000)).rejects.toThrow(
      /Dataview community plugin is not installed/,
    );
  });

  it('dataview() surfaces a 400 dql_error verbatim', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'dql_error',
          message: 'Unexpected token at line 1, column 5',
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('garbage query', undefined, 5000)).rejects.toThrow(
      /dql_error: Unexpected token/,
    );
  });

  it('dataview() aborts at timeoutMs with a dataview-specific error message', async () => {
    server = createServer((_req, res) => {
      // Never responds — force the client's AbortController to fire.
      void res;
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    const start = Date.now();
    await expect(client.dataview('TABLE x', undefined, 150)).rejects.toThrow(
      /Dataview query exceeded timeoutMs=150/,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2000);
  });
});
