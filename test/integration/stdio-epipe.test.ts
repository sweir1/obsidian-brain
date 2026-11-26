/**
 * Issue #41: a client closing the stdio pipes killed the server with an
 * uncaught `write EPIPE` (and a misleading last-startup-error.log entry).
 *
 * These tests use real OS pipes: a child process loads the production
 * modules from source (via tsx), the parent closes the child's stderr or
 * stdout read end, and the child keeps writing. Before the fix the first
 * write after the close crashed the child with exit 1.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const GLOBAL_HANDLERS = JSON.stringify(join(SRC, 'global-handlers.ts'));
const LOGGER = JSON.stringify(join(SRC, 'util', 'logger.ts'));
const STDIO_GUARD = JSON.stringify(join(SRC, 'util', 'stdio-guard.ts'));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ob-epipe-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runChild(script: string, close: 'stdout' | 'stderr') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, OBSIDIAN_BRAIN_DEBUG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Closing our read end makes the child's next write fail with EPIPE.
  child[close].destroy();
  const other = close === 'stdout' ? child.stderr : child.stdout;
  let output = '';
  other.on('data', (c: Buffer) => {
    output += c.toString();
  });
  return {
    child,
    exited: once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
    output: () => output,
  };
}

const crashLog = () => join(home, '.cache', 'obsidian-brain', 'last-startup-error.log');

describe('stdio EPIPE (real pipes)', () => {
  it('logging after the client closed stderr does not crash or write a crash log', async () => {
    const script = `
      await import(${GLOBAL_HANDLERS});
      const { logger } = await import(${LOGGER});
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 40; i++) {
        logger.info('line ' + i);
        await new Promise((r) => setTimeout(r, 5));
      }
      process.stdout.write('survived\\n');
      process.exitCode = 0;
    `;
    const { exited, output } = runChild(script, 'stderr');
    const [code] = await exited;
    expect(code).toBe(0);
    expect(output()).toContain('survived');
    expect(existsSync(crashLog())).toBe(false);
  }, 30_000);

  it('a closed stdout invokes the registered lost-handler instead of crashing', async () => {
    const script = `
      await import(${GLOBAL_HANDLERS});
      const { setStdoutLostHandler } = await import(${STDIO_GUARD});
      setStdoutLostHandler((err) => {
        process.stderr.write('lost:' + err.code + '\\n');
        process.exit(0);
      });
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 200; i++) {
        process.stdout.write('{"jsonrpc":"2.0"}\\n');
        await new Promise((r) => setTimeout(r, 5));
      }
      process.exit(3); // only reached if the handler never fired
    `;
    const { exited, output } = runChild(script, 'stdout');
    const [code] = await exited;
    expect(code).toBe(0);
    expect(output()).toMatch(/lost:(EPIPE|ECONNRESET|EOF|ERR_STREAM_DESTROYED)/);
    expect(existsSync(crashLog())).toBe(false);
  }, 30_000);

  it('without a lost-handler a closed stdout is ignored (CLI piping into a closed reader)', async () => {
    const script = `
      await import(${GLOBAL_HANDLERS});
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 50; i++) {
        process.stdout.write('{"result":1}\\n');
        await new Promise((r) => setTimeout(r, 5));
      }
      process.stderr.write('finished\\n');
    `;
    const { exited, output } = runChild(script, 'stdout');
    const [code] = await exited;
    expect(code).toBe(0);
    expect(output()).toContain('finished');
    expect(existsSync(crashLog()) ? readFileSync(crashLog(), 'utf8') : '').toBe('');
  }, 30_000);
});
