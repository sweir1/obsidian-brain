/**
 * mcp-smoke.ts — end-to-end stdio smoke test for the obsidian-brain MCP server.
 *
 * Spawns `node dist/server.js` against a throwaway tmp vault, speaks the
 * JSON-RPC protocol by hand, and calls every registered tool in a realistic
 * order. Exits 0 on all-pass, 1 on any failure.
 *
 * Run: `npm run smoke` (or `tsx scripts/mcp-smoke.ts`).
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { McpStdioClient, type JsonRpcResponse } from './mcp-client.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  'search',
  'read_note',
  'list_notes',
  'find_connections',
  'find_path_between',
  'detect_themes',
  'rank_notes',
  'create_note',
  'edit_note',
  'link_notes',
  'move_note',
  'delete_note',
  'reindex',
] as const;

const FAST_TIMEOUT_MS = 5_000;
const SLOW_TIMEOUT_MS = 30_000; // covers embedder model download (~34MB for bge-small-en-v1.5)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

function seedVault(vaultPath: string): void {
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, 'Concepts'), { recursive: true });

  writeFileSync(
    join(vaultPath, 'Welcome.md'),
    [
      '# Welcome',
      '',
      'Welcome to the smoke-test vault. See [[Concepts/Widgets]].',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(vaultPath, 'Concepts', 'Widgets.md'),
    [
      '---',
      'type: Concept',
      'tags: [widgets, demo]',
      '---',
      '',
      '# Widgets',
      '',
      'Widgets connect back to [[Welcome]] and forward to [[Concepts/Gadgets]].',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(vaultPath, 'Concepts', 'Gadgets.md'),
    [
      '---',
      'type: Concept',
      'tags: [gadgets, demo]',
      '---',
      '',
      '# Gadgets',
      '',
      'Stub note, no backlinks.',
      '',
    ].join('\n'),
  );
}

/** A single call: returns pass/fail + error message. Records timing. */
async function runCall(
  name: string,
  results: TestResult[],
  fn: () => Promise<JsonRpcResponse>,
  opts: { allowError?: boolean } = {},
): Promise<JsonRpcResponse | null> {
  const start = Date.now();
  log(`> ${name} start`);
  try {
    const resp = await fn();
    const durationMs = Date.now() - start;

    if (resp.error) {
      const msg = `rpc error ${resp.error.code}: ${resp.error.message}`;
      results.push({ name, pass: false, error: msg, durationMs });
      log(`< ${name} FAIL (${durationMs}ms): ${msg}`);
      return resp;
    }

    // Tool calls wrap output in { content: [...], isError?: true }.
    const result = resp.result as { content?: unknown; isError?: boolean } | undefined;
    if (result?.isError === true && !opts.allowError) {
      const text = extractText(result);
      results.push({ name, pass: false, error: `tool isError: ${text}`, durationMs });
      log(`< ${name} FAIL (${durationMs}ms): tool isError: ${text}`);
      return resp;
    }

    results.push({ name, pass: true, durationMs });
    log(`< ${name} ok (${durationMs}ms)`);
    return resp;
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, error: msg, durationMs });
    log(`< ${name} FAIL (${durationMs}ms): ${msg}`);
    return null;
  }
}

function extractText(result: { content?: unknown } | undefined): string {
  if (!result) return '(no result)';
  const content = result.content;
  if (!Array.isArray(content)) return '(no content)';
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
      parts.push((c as { text: string }).text);
    }
  }
  return parts.join('\n').slice(0, 500);
}

function callTool(
  client: McpStdioClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  return client.sendRequest('tools/call', { name, arguments: args }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const serverScript = resolve(repoRoot, 'dist', 'server.js');

  // Sanity-check the build output up front so we give a clear error instead
  // of a cryptic spawn failure.
  const check = spawnSync('node', ['-e', "require('fs').statSync(process.argv[1])", serverScript], {
    stdio: 'ignore',
  });
  if (check.status !== 0) {
    process.stderr.write(`Server script not found at ${serverScript}. Run 'npm run build' first.\n`);
    return 1;
  }

  const vaultPath = join(tmpdir(), `obsidian-brain-smoke-${randomSuffix()}`);
  const dataDir = join(vaultPath, 'data');
  log(`vault=${vaultPath}`);
  seedVault(vaultPath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VAULT_PATH: vaultPath,
    DATA_DIR: dataDir,
  };

  const client = new McpStdioClient('node', [serverScript], env, repoRoot);
  const results: TestResult[] = [];

  try {
    // ---- handshake ---------------------------------------------------------
    log('> initialize');
    const initResp = await client.sendRequest(
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      },
      FAST_TIMEOUT_MS,
    );
    if (initResp.error) {
      throw new Error(`initialize failed: ${initResp.error.message}`);
    }
    log('< initialize ok');
    client.sendNotification('notifications/initialized');

    // ---- tools/list --------------------------------------------------------
    const listResp = await runCall('tools/list', results, () =>
      client.sendRequest('tools/list', {}, FAST_TIMEOUT_MS),
    );
    if (listResp && !listResp.error) {
      const tools = (listResp.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
      const names = new Set(tools.map((t) => t.name));
      const missing = EXPECTED_TOOLS.filter((n) => !names.has(n));
      if (tools.length < EXPECTED_TOOLS.length || missing.length > 0) {
        const failure: TestResult = {
          name: 'tools/list contents',
          pass: false,
          error: `got ${tools.length} tools, missing=${JSON.stringify(missing)}`,
          durationMs: 0,
        };
        results.push(failure);
        log(`< tools/list contents FAIL: ${failure.error}`);
      } else {
        results.push({ name: 'tools/list contents', pass: true, durationMs: 0 });
      }
    }

    // ---- tool call sequence ------------------------------------------------
    // reindex first — seeds the graph store. Slow: loads the embedder.
    await runCall('reindex (seed)', results, () => callTool(client, 'reindex', {}, SLOW_TIMEOUT_MS), {
      allowError: false,
    });

    await runCall('search', results, () =>
      callTool(client, 'search', { query: 'welcome', limit: 5 }, SLOW_TIMEOUT_MS),
    );

    await runCall('list_notes', results, () =>
      callTool(client, 'list_notes', { limit: 10 }, FAST_TIMEOUT_MS),
    );

    await runCall('read_note (brief)', results, () =>
      callTool(client, 'read_note', { name: 'Widgets' }, FAST_TIMEOUT_MS),
    );

    await runCall('find_connections', results, () =>
      callTool(client, 'find_connections', { name: 'Welcome', depth: 2 }, FAST_TIMEOUT_MS),
    );

    await runCall('find_path_between', results, () =>
      callTool(
        client,
        'find_path_between',
        { from: 'Welcome', to: 'Gadgets', maxDepth: 3, includeCommon: true },
        FAST_TIMEOUT_MS,
      ),
    );

    await runCall('detect_themes (list)', results, () =>
      callTool(client, 'detect_themes', {}, FAST_TIMEOUT_MS),
    );

    await runCall('rank_notes (both)', results, () =>
      callTool(client, 'rank_notes', { metric: 'both', limit: 5 }, FAST_TIMEOUT_MS),
    );

    await runCall('rank_notes (influence)', results, () =>
      callTool(client, 'rank_notes', { metric: 'influence', limit: 5 }, FAST_TIMEOUT_MS),
    );

    await runCall('create_note', results, () =>
      callTool(
        client,
        'create_note',
        {
          title: 'Smoke Test',
          content: 'Created by the smoke-test script.\n',
          frontmatter: { tags: ['smoke'] },
        },
        SLOW_TIMEOUT_MS,
      ),
    );

    await runCall('edit_note (append)', results, () =>
      callTool(
        client,
        'edit_note',
        { name: 'Smoke Test', mode: 'append', content: ' more text' },
        SLOW_TIMEOUT_MS,
      ),
    );

    await runCall('link_notes', results, () =>
      callTool(
        client,
        'link_notes',
        { source: 'Smoke Test', target: 'Widgets', context: 'Smoke test cross-link' },
        SLOW_TIMEOUT_MS,
      ),
    );

    await runCall('move_note', results, () =>
      callTool(
        client,
        'move_note',
        { source: 'Smoke Test', destination: 'Archive/Smoke Moved.md' },
        SLOW_TIMEOUT_MS,
      ),
    );

    await runCall('delete_note', results, () =>
      callTool(
        client,
        'delete_note',
        { name: 'Smoke Moved', confirm: true },
        SLOW_TIMEOUT_MS,
      ),
    );

    await runCall('reindex (final)', results, () =>
      callTool(client, 'reindex', {}, SLOW_TIMEOUT_MS),
    );
  } finally {
    log('shutting down server');
    await client.shutdown().catch(() => { /* ignore */ });
    await rm(vaultPath, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }

  // ---- summary -------------------------------------------------------------
  process.stdout.write('\n=== Smoke test results ===\n');
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const detail = r.pass ? '' : ` — ${r.error}`;
    process.stdout.write(`${mark} ${r.name} (${r.durationMs}ms)${detail}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);

  if (failed.length > 0) {
    process.stdout.write('\nServer stderr tail:\n');
    process.stdout.write(client.stderrText().slice(-4000) + '\n');
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`smoke test crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);

// Marker so tsc doesn't complain about the file-url import being "unused".
export const SMOKE_ENTRY = __filename;
