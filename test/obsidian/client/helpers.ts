/**
 * Local test helpers for ObsidianClient. Discovery file writer + a tiny
 * auth-gated HTTP server. Several tests also construct `createServer`
 * directly when they need to stream the request body — `startServer`
 * intentionally does not generalise to that case.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

export function writeDiscovery(
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

export function startServer(
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

export async function portOf(s: Server): Promise<number> {
  const addr = s.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('no port');
}
