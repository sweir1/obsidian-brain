import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Tests for src/util/debug-log.ts — synchronous startup-trace logger.
 *
 * **Coverage strategy.** The function uses `fs.writeSync(2, …)` which
 * goes straight to the OS, bypassing the `silence-stderr.ts` setup
 * that mocks `process.stderr.write`. To get in-process coverage
 * (vitest's v8 coverage doesn't follow into spawned children) without
 * polluting the test runner's stderr, we use `vi.mock('node:fs')` at
 * module top-level — vitest hoists it before module imports, the
 * factory replaces just `writeSync` with a `vi.fn()`, and other fs
 * functions are passed through via `vi.importActual`. Tests can then
 * assert on the spy without writeSync ever reaching real fd 2.
 *
 * **End-to-end verification.** A separate child-process suite below
 * spawns a real Node process, sets `OBSIDIAN_BRAIN_DEBUG=1` in the
 * child's env, imports `dist/util/debug-log.js`, and verifies the
 * actual stderr output via the parent's pipe. That suite proves the
 * real OS-level behavior end-to-end, but doesn't contribute to the
 * parent process's coverage metric (different process). The two
 * suites complement each other: in-process for coverage credit,
 * child-process for behavioral correctness.
 *
 * **The gate** (`isDebugEnabled` + `debugLog` no-op when disabled) is
 * captured at module-load time, so we re-import via `vi.resetModules()`
 * after toggling the env var.
 */

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Mocked writeSync so the in-process write tests don't pollute the
    // test runner's stderr. The mock is reset between tests via
    // vi.clearAllMocks() in afterEach.
    writeSync: vi.fn(() => 0),
  };
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DEBUG_LOG = join(REPO_ROOT, 'dist', 'util', 'debug-log.js');

let originalDebug: string | undefined;

beforeEach(() => {
  originalDebug = process.env.OBSIDIAN_BRAIN_DEBUG;
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalDebug === undefined) delete process.env.OBSIDIAN_BRAIN_DEBUG;
  else process.env.OBSIDIAN_BRAIN_DEBUG = originalDebug;
});

describe('debug-log — gate (isDebugEnabled)', () => {
  it('returns false when OBSIDIAN_BRAIN_DEBUG is unset', async () => {
    delete process.env.OBSIDIAN_BRAIN_DEBUG;
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(mod.isDebugEnabled()).toBe(false);
  });

  it('returns false for empty string (explicit-truthy guard, not JS truthiness)', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '';
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(mod.isDebugEnabled()).toBe(false);
  });

  it('returns false for "0" (numeric-string falsy convention)', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '0';
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(mod.isDebugEnabled()).toBe(false);
  });

  it('returns false for "true" (must be exactly "1", not loose truthy)', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = 'true';
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(mod.isDebugEnabled()).toBe(false);
  });

  it('returns true when OBSIDIAN_BRAIN_DEBUG === "1"', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(mod.isDebugEnabled()).toBe(true);
  });
});

describe('debug-log — no-op path (gate disabled)', () => {
  it('debugLog() returns without invoking writeSync when DEBUG unset', async () => {
    delete process.env.OBSIDIAN_BRAIN_DEBUG;
    vi.resetModules();
    const fs = await import('node:fs');
    const mod = await import('../../src/util/debug-log.js');
    mod.debugLog('this should be a no-op');
    expect(fs.writeSync).not.toHaveBeenCalled();
  });

  it('debugLog() returns without invoking writeSync when DEBUG="0"', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '0';
    vi.resetModules();
    const fs = await import('node:fs');
    const mod = await import('../../src/util/debug-log.js');
    mod.debugLog('still a no-op');
    expect(fs.writeSync).not.toHaveBeenCalled();
  });

  it('handles 10k disabled invocations rapidly (no perf hit)', async () => {
    delete process.env.OBSIDIAN_BRAIN_DEBUG;
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) mod.debugLog(`iteration ${i}`);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('debug-log — write path (in-process via vi.mock node:fs)', () => {
  it('debugLog() invokes fs.writeSync(2, formatted-message) when DEBUG="1"', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const fs = await import('node:fs');
    const mod = await import('../../src/util/debug-log.js');
    mod.debugLog('hello world');
    expect(fs.writeSync).toHaveBeenCalledTimes(1);
    const [fd, body] = (fs.writeSync as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fd).toBe(2);
    expect(String(body)).toMatch(/^obsidian-brain debug \[\+\d+ms\]: hello world\n$/);
  });

  it('multiple debugLog calls each invoke writeSync once with monotonic timestamps', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const fs = await import('node:fs');
    const mod = await import('../../src/util/debug-log.js');
    mod.debugLog('first');
    mod.debugLog('second');
    mod.debugLog('third');
    expect(fs.writeSync).toHaveBeenCalledTimes(3);
    const calls = (fs.writeSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const ts = calls.map((c) => Number(/\[\+(\d+)ms\]/.exec(String(c[1]))![1]));
    expect(ts[1]).toBeGreaterThanOrEqual(ts[0]);
    expect(ts[2]).toBeGreaterThanOrEqual(ts[1]);
  });

  it('debugLog() swallows writeSync errors (fd 2 closed scenario)', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const fs = await import('node:fs');
    (fs.writeSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('EBADF: fd 2 closed');
    });
    const mod = await import('../../src/util/debug-log.js');
    expect(() => mod.debugLog('test')).not.toThrow();
  });

  it('handles empty messages without throwing', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const mod = await import('../../src/util/debug-log.js');
    expect(() => mod.debugLog('')).not.toThrow();
  });

  it('handles multi-line messages (no escaping done — raw passthrough)', async () => {
    process.env.OBSIDIAN_BRAIN_DEBUG = '1';
    vi.resetModules();
    const fs = await import('node:fs');
    const mod = await import('../../src/util/debug-log.js');
    mod.debugLog('line1\nline2');
    const body = String((fs.writeSync as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
    expect(body).toContain('line1\nline2');
  });
});

describe('debug-log — write path (child-process, end-to-end stderr verification)', () => {
  // The vi.mock above replaces node:fs WITHIN this test file. The child
  // process below has the REAL node:fs, so it actually writes to fd 2 —
  // and we capture its stderr to verify the real OS-level behavior.
  function runChildWithDebug(envValue: string | null, msgs: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const env = { ...process.env };
    if (envValue === null) delete env.OBSIDIAN_BRAIN_DEBUG;
    else env.OBSIDIAN_BRAIN_DEBUG = envValue;

    const script = `
      import('${DIST_DEBUG_LOG.replace(/\\/g, '\\\\')}').then(({ debugLog }) => {
        ${msgs.map((m) => `debugLog(${JSON.stringify(m)});`).join('\n        ')}
      });
    `;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  it('writes to fd 2 (stderr) — not fd 1 (stdout) — when DEBUG=1', () => {
    const r = runChildWithDebug('1', ['hello world']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hello world');
  });

  it('produces zero output to either stream when DEBUG is not set', () => {
    const r = runChildWithDebug(null, ['this should not appear']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('produces zero output when DEBUG="0"', () => {
    const r = runChildWithDebug('0', ['nope']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});
