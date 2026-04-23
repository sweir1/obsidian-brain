import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObsidianClient } from '../../../src/obsidian/client.js';
import { portOf, startServer, writeDiscovery } from './helpers.js';

/**
 * Full contract for client.base(): capability fast-reject, 424 error paths,
 * happy-path body round-trip.
 */
describe.sequential('ObsidianClient — base', () => {
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

  it('base() rejects fast when the plugin lacks the base capability', async () => {
    server = await startServer('tok', () => ({ status: 200, body: {} }));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active', 'dataview'],
      pluginVersion: '0.2.1',
    });
    const client = new ObsidianClient(vault);
    await expect(
      client.base({ view: 'default', yaml: 'views:\n  default: {}' }, { timeoutMs: 5000 }),
    ).rejects.toThrow(/1\.4\.0 or later/);
  });

  it('base() surfaces a 424 bases_not_enabled as PluginUnavailableError', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'bases_not_enabled',
          message:
            "Obsidian's Bases core plugin is not enabled in this vault. Obsidian → Settings → Core plugins → toggle 'Bases' on, then retry.",
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active', 'dataview', 'base'],
      pluginVersion: '1.4.0',
    });
    const client = new ObsidianClient(vault);
    await expect(
      client.base({ view: 'default', yaml: 'views:\n  default: {}' }, { timeoutMs: 5000 }),
    ).rejects.toThrow(/Settings → Core plugins → toggle 'Bases'/);
  });

  it('base() surfaces a 424 unsupported_obsidian_version with upgrade remediation', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 424;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'unsupported_obsidian_version',
          message:
            "Obsidian's Bases feature requires Obsidian 1.10.0 or later. Please upgrade Obsidian and retry.",
        }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active', 'dataview', 'base'],
      pluginVersion: '1.4.0',
    });
    const client = new ObsidianClient(vault);
    await expect(
      client.base({ view: 'default', yaml: 'views:\n  default: {}' }, { timeoutMs: 5000 }),
    ).rejects.toThrow(/requires Obsidian 1\.10\.0 or later/);
  });

  it('base() parses a happy-path {view, rows, total, executedAt} payload over HTTP', async () => {
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
            view: 'active-books',
            rows: [
              { file: { name: 'Dune', path: 'books/Dune.md' }, status: 'reading', rating: 5 },
            ],
            total: 1,
            executedAt: '2026-04-23T10:30:00.000Z',
          }),
        );
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = await portOf(server);
    writeDiscovery(vault, {
      port,
      token: 'tok',
      capabilities: ['status', 'active', 'dataview', 'base'],
      pluginVersion: '1.4.0',
    });
    const client = new ObsidianClient(vault);
    const out = await client.base(
      { view: 'active-books', yaml: 'views:\n  active-books: {}' },
      { timeoutMs: 5000 },
    );
    expect(out.view).toBe('active-books');
    expect(out.total).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.file.name).toBe('Dune');
    expect(out.rows[0]!.file.path).toBe('books/Dune.md');
    expect(out.rows[0]!.status).toBe('reading');
    expect(out.rows[0]!.rating).toBe(5);
    expect(out.executedAt).toBe('2026-04-23T10:30:00.000Z');
    expect(JSON.parse(receivedBody)).toEqual({
      view: 'active-books',
      yaml: 'views:\n  active-books: {}',
    });
  });
});
