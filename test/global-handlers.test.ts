import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests for src/global-handlers.ts — the v1.7.11 last-resort error nets.
 *
 * Strategy: avoid spying on `fs.writeSync` directly — vitest can't redefine
 * read-only ESM namespace bindings ("Cannot redefine property"). Instead,
 * we verify the side effect that's observable: the crash-log file at
 * `~/.cache/obsidian-brain/last-startup-error.log`. recordCrash writes
 * the same content (with extra metadata) to that file as it writes to
 * fd 2, so file-based assertions cover the recordCrash path end-to-end.
 *
 * For onUncaughtException / onUnhandledRejection, we mock `process.exit`
 * (which IS spy-able since `process` isn't an ESM namespace), and
 * additionally verify the file write happened.
 */

let tmpHome: string;
let originalHome: string | undefined;
let mod: typeof import('../src/global-handlers.js');

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ob-global-handlers-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  vi.resetModules();
  mod = await import('../src/global-handlers.js');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function readCrashLog(): string {
  return readFileSync(
    join(tmpHome, '.cache', 'obsidian-brain', 'last-startup-error.log'),
    'utf8',
  );
}

describe('global-handlers — recordCrash', () => {
  it('uncaught-exception with Error: writes a recoverable crash-log file with banner + stack', () => {
    mod.recordCrash('uncaught-exception', new Error('BOOM'));

    const text = readCrashLog();
    expect(text).toContain('# obsidian-brain uncaught-exception');
    expect(text).toContain('type:      uncaught-exception');
    expect(text).toContain(`node:      ${process.version}`);
    expect(text).toContain(`abi:       ${process.versions.modules}`);
    expect(text).toContain(`platform:  ${process.platform}-${process.arch}`);
    expect(text).toContain('BOOM');
    expect(text).toMatch(/timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('unhandled-rejection: log file uses rejection-specific marker line', () => {
    mod.recordCrash('unhandled-rejection', new Error('async boom'));
    const text = readCrashLog();
    expect(text).toContain('# obsidian-brain unhandled-rejection');
    expect(text).toContain('type:      unhandled-rejection');
    expect(text).toContain('async boom');
    expect(text).not.toContain('uncaught-exception');
  });

  it('non-Error reason: still produces output via String() coercion', () => {
    mod.recordCrash('unhandled-rejection', 'plain-string-rejection');
    const text = readCrashLog();
    expect(text).toContain('plain-string-rejection');
  });

  it('survives crash-log file write failure silently (best-effort)', async () => {
    // Force `~/.cache/obsidian-brain` to be a FILE instead of a directory
    // so mkdirSync / writeFileSync inside recordCrash hits ENOTDIR. The
    // `try { … } catch` should swallow that.
    const cacheDir = join(tmpHome, '.cache');
    const fs = await import('node:fs');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(join(cacheDir, 'obsidian-brain'), 'blocking file, not a dir');

    expect(() => mod.recordCrash('uncaught-exception', new Error('test'))).not.toThrow();
  });

  it('passing a plain object (not an Error) coerces via String() and still writes log', () => {
    mod.recordCrash('uncaught-exception', { weird: 'object' });
    const text = readCrashLog();
    expect(text).toContain('[object Object]');
  });
});

describe('global-handlers — onUncaughtException / onUnhandledRejection', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Replace process.exit with a throw — provably stops the test runner
    // from exiting AND lets us assert "exit was called with code 1".
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`__test_exit_${code ?? 0}__`);
      }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('onUncaughtException records crash + exits with code 1', () => {
    expect(() => mod.onUncaughtException(new Error('uncaught test'))).toThrow(/__test_exit_1__/);
    const text = readCrashLog();
    expect(text).toContain('uncaught-exception');
    expect(text).toContain('uncaught test');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('onUnhandledRejection records crash + exits with code 1', () => {
    expect(() => mod.onUnhandledRejection(new Error('rejection test'))).toThrow(/__test_exit_1__/);
    const text = readCrashLog();
    expect(text).toContain('unhandled-rejection');
    expect(text).toContain('rejection test');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('global-handlers — module-import side effect (registration)', () => {
  it('registers both uncaughtException and unhandledRejection listeners on import', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    vi.resetModules();
    await import('../src/global-handlers.js');
    const events = processOnSpy.mock.calls.map(([evt]) => evt);
    expect(events).toContain('uncaughtException');
    expect(events).toContain('unhandledRejection');
    processOnSpy.mockRestore();
  });
});
