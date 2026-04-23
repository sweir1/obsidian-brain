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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
