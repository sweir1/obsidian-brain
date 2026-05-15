/**
 * Integration tests for the MCP server's shutdown path.
 *
 * Originally added in v1.6.8 to verify stdin-EOF shutdown. v1.6.9 replaced
 * the raw `process.stdin.on('end'|'close', exit)` handlers with
 * `transport.onclose` + a PPID orphan watcher (stdin-EOF handlers false-fired
 * under Jan during its local-LLM load). v1.6.10 added orderly teardown of
 * ONNX Runtime + better-sqlite3 before exit to kill the `libc++abi: mutex
 * lock failed` crash observed in real logs.
 *
 * The tests below verify:
 *   1. Stdin EOF: the process still exits cleanly (via event-loop drain)
 *      within a few seconds, because no ref'd handles remain.
 *   2. SIGTERM (v1.6.10): clean shutdown path runs, exit code 0, and no
 *      native-thread-pool crash signatures (`libc++abi`, `mutex lock
 *      failed`) on stderr.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function spawnServer(vault: string) {
  const cliPath = join(process.cwd(), 'dist', 'cli', 'index.js');
  return spawn(process.execPath, [cliPath, 'server'], {
    env: {
      ...process.env,
      VAULT_PATH: vault,
      OBSIDIAN_BRAIN_NO_WATCH: '1',
      OBSIDIAN_BRAIN_NO_CATCHUP: '1',
      // Skip the embedder download for test speed. This also means ONNX
      // Runtime's thread pool is never initialized — the libc++abi check is
      // about the SHUTDOWN PATH being safe when the embedder may or may not
      // be ready, not about literally reproducing the crash (that needs a
      // real model; covered by manual verification in RELEASING.md).
      EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1', // unreachable; background init fails fast
      OLLAMA_EMBEDDING_DIM: '384',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe.sequential('server shutdown', () => {
  let vault: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-stdin-'));
    writeFileSync(join(vault, 'note.md'), '# Note\n\nhello\n');
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('exits within 3s of stdin EOF (event-loop drain after pipe close)', async () => {
    const child = spawnServer(vault);
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.end();

    const exitPromise = once(child, 'exit');
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('server did not exit within 3s of stdin EOF')), 3000),
    );
    const [code] = (await Promise.race([exitPromise, timeoutPromise])) as [number | null];
    expect(typeof code === 'number').toBe(true);
  }, 15_000);

  it('v1.6.10: clean shutdown on SIGTERM with no native crash on stderr', async () => {
    const child = spawnServer(vault);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Give the child time to reach its main server loop (past createContext +
    // tools/register) before signalling it.
    await new Promise((r) => setTimeout(r, 1_000));

    child.kill('SIGTERM');

    const exitPromise = once(child, 'exit');
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('server did not exit within 6s of SIGTERM')), 6_000),
    );
    const [code] = (await Promise.race([exitPromise, timeoutPromise])) as [number | null];

    expect(code).toBe(0);
    // The crash signature we're guarding against. Either substring appearing
    // in stderr means a native worker thread was torn down mid-lock.
    expect(stderr).not.toMatch(/libc\+\+abi/);
    expect(stderr).not.toMatch(/mutex lock failed/);
    // And the clean-shutdown message should have appeared.
    expect(stderr).toMatch(/shutting down \(SIGTERM\)/);
  }, 15_000);
});

/**
 * L1 integration test (v1.7.22 Task C): closes the audit gap left by
 * v1.7.19's shutdown-drain change. The unit test in `test/server-shutdown.test.ts`
 * verifies the drain logic with mocks; this test exercises the whole stack —
 * real child process, real embedder (bge-small-en-v1.5), real SQLite writes,
 * real SIGTERM mid-reindex — and asserts the on-disk DB is intact after exit.
 *
 * Gated on OB_INTEGRATION_REAL_EMBEDDER=1 because it downloads ~34 MB and
 * takes 10-30 s. Default CI runs skip it; opt in locally with
 *   OB_INTEGRATION_REAL_EMBEDDER=1 npx vitest run test/integration/server-stdin-shutdown.test.ts
 */
const runRealEmbedder = process.env.OB_INTEGRATION_REAL_EMBEDDER === '1';

describe.skipIf(!runRealEmbedder)('server shutdown — real reindex mid-flight (L1)', () => {
  let vault: string;
  let dataDir: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-l1-vault-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ob-l1-data-'));
    // ~40 small notes — large enough that the indexer loop spends a few
    // hundred ms processing files (one note at a time is too fast to
    // interrupt cleanly), small enough that the test still finishes
    // quickly when SIGTERM lands.
    for (let i = 0; i < 40; i++) {
      writeFileSync(
        join(vault, `note-${String(i).padStart(2, '0')}.md`),
        `# Note ${i}\n\nThis is the body of note ${i}. It mentions topics like ` +
          `widgets, gadgets, telescopes, and submarines. See [[note-${(i + 1) % 40}]].\n`,
      );
    }
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    'exits cleanly on SIGTERM mid-reindex and leaves the DB non-corrupt with forward progress',
    async () => {
      const cliPath = join(process.cwd(), 'dist', 'cli', 'index.js');
      if (!existsSync(cliPath)) {
        throw new Error(
          `dist/cli/index.js not found at ${cliPath}. Run \`npm run build\` first.`,
        );
      }

      const child = spawn(process.execPath, [cliPath, 'server'], {
        env: {
          ...process.env,
          VAULT_PATH: vault,
          DATA_DIR: dataDir,
          // Force the local default embedder (bge-small-en-v1.5, ~34 MB).
          // Explicit so the test isn't at the mercy of inherited env vars.
          EMBEDDING_PRESET: 'english',
          // Disable the auto-fired catchup reindex and watcher so the only
          // work the server does is the explicit `tools/call reindex` below.
          // (The empty-DB-first-time-index path still fires, which is what
          // we want — that goes through enqueueBackgroundReindex and so
          // exercises ctx.pendingReindex on the shutdown drain.)
          OBSIDIAN_BRAIN_NO_CATCHUP: '1',
          OBSIDIAN_BRAIN_NO_WATCH: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // -- MCP initialize handshake (newline-delimited JSON-RPC). ----------
      const initReq = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'l1-shutdown-test', version: '1' },
        },
      };
      child.stdin.write(JSON.stringify(initReq) + '\n');

      // Wait for the initialize response on stdout (timeout 10 s).
      const initDeadline = Date.now() + 10_000;
      while (Date.now() < initDeadline) {
        const nl = stdoutBuf.indexOf('\n');
        if (nl !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.length > 0) {
            const msg = JSON.parse(line) as { id?: number; result?: unknown };
            if (msg.id === 1 && msg.result) break;
          }
        } else {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );

      // -- Fire reindex. Don't await the response — we'll SIGTERM mid-flight.
      const reindexReq = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'reindex', arguments: {} },
      };
      child.stdin.write(JSON.stringify(reindexReq) + '\n');

      // 1500 ms is empirically the sweet spot for 40 notes with the bge
      // model: the embedder has finished loading and the indexer loop is
      // partway through embedding the batch. Shorter (<500ms) lands before
      // the model is loaded; longer (>5s) and a small vault is already done.
      await new Promise((r) => setTimeout(r, 1_500));

      child.kill('SIGTERM');

      const exitPromise = once(child, 'exit');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('server did not exit within 10s of SIGTERM')),
          10_000,
        ),
      );
      const [code] = (await Promise.race([exitPromise, timeoutPromise])) as [
        number | null,
      ];

      // ASSERTION 1: exit code 0 — the SIGTERM handler ran to completion
      // and set process.exitCode = 0. A non-zero exit means a teardown
      // path threw or the hard-exit timer fired before clean shutdown.
      expect(code).toBe(0);

      // ASSERTION 2: no native-thread-pool crash on stderr. Same guard
      // as the v1.6.10 test above, applied to the mid-reindex case where
      // ONNX Runtime is actively producing embeddings when SIGTERM fires.
      expect(stderr).not.toMatch(/libc\+\+abi/);
      expect(stderr).not.toMatch(/mutex lock failed/);

      // ASSERTION 3: the SQLite file is reachable and not corrupt, and
      // the indexer made forward progress before being interrupted —
      // i.e. the shutdown drain actually let committed writes survive
      // instead of slamming the DB closed mid-transaction.
      const dbPath = join(dataDir, 'kg.db');
      expect(existsSync(dbPath)).toBe(true);

      const require_ = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSqlite3 = require_('better-sqlite3') as typeof import('better-sqlite3');
      const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
      try {
        // integrity_check returns a single row with value 'ok' for a healthy DB.
        const integrity = db.prepare('PRAGMA integrity_check').get() as {
          integrity_check: string;
        };
        expect(integrity.integrity_check).toBe('ok');

        const row = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as {
          n: number;
        };
        // At least one node persisted — the drain let in-flight writes
        // commit before the DB handle closed. (Exact count varies with
        // where SIGTERM lands in the embedding loop; we only care that
        // forward progress survived.)
        expect(row.n).toBeGreaterThanOrEqual(1);
      } finally {
        db.close();
      }
    },
    90_000, // generous: includes model download on first run
  );
});
