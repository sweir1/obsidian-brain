import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObsidianClient } from '../../../src/obsidian/client.js';
import { portOf, startServer, writeDiscovery } from './helpers.js';

/**
 * Capability declarations + the full dataview endpoint contract — parse,
 * four error paths, timeout abort. Some tests need body-streaming and use
 * raw createServer; startServer's simple handler doesn't cover that case.
 */
describe.sequential('ObsidianClient — dataview', () => {
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

  it('dataview() surfaces a 424 dataview_not_installed as PluginUnavailableError', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'dataview_not_installed',
          message:
            "The Dataview community plugin is not installed in this vault. Install it: Obsidian → Settings → Community plugins → Browse → search 'Dataview' (by blacksmithgu) → Install → Enable.",
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('TABLE file.name', undefined, 5000)).rejects.toThrow(
      /Settings → Community plugins → Browse/,
    );
  });

  it('dataview() surfaces a 424 dataview_not_enabled with toggle-on remediation', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'dataview_not_enabled',
          message:
            "The Dataview community plugin is installed but not enabled in this vault. Obsidian → Settings → Community plugins → toggle 'Dataview' on, then retry.",
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('TABLE file.name', undefined, 5000)).rejects.toThrow(
      /toggle 'Dataview' on/,
    );
  });

  it('dataview() surfaces a 424 dataview_api_not_ready with reload-Obsidian remediation', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'dataview_api_not_ready',
          message:
            "The Dataview community plugin is enabled but its API isn't registered on app.plugins.plugins.dataview yet. Reload Obsidian (Command palette → 'Reload app without saving', or ⌘R / Ctrl+R) and retry — this usually clears within a few seconds of enabling the plugin.",
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, { port, token: 'tok' });
    const client = new ObsidianClient(vault);
    await expect(client.dataview('TABLE file.name', undefined, 5000)).rejects.toThrow(
      /Reload Obsidian/,
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
