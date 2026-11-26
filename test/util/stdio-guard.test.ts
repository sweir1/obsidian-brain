import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  installStdioGuards,
  isBrokenPipeError,
  onStderrError,
  onStdoutError,
  routeConsoleToStderr,
  setStdoutLostHandler,
} from '../../src/util/stdio-guard.js';

/**
 * Unit tests for src/util/stdio-guard.ts (issue #41: a client closing the
 * stdio pipes surfaced as an uncaught `write EPIPE` crash). The real-pipe
 * behaviour is covered end-to-end in test/integration/stdio-epipe.test.ts;
 * these tests pin the policy with injected stand-in streams.
 */

function codedError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

afterEach(() => {
  setStdoutLostHandler(null);
});

describe('isBrokenPipeError', () => {
  it.each(['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])(
    'recognises %s',
    (code) => {
      expect(isBrokenPipeError(codedError(code))).toBe(true);
    },
  );

  it('rejects other codes, code-less errors and non-objects', () => {
    expect(isBrokenPipeError(codedError('EACCES'))).toBe(false);
    expect(isBrokenPipeError(new Error('no code'))).toBe(false);
    expect(isBrokenPipeError({ code: 42 })).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError('EPIPE')).toBe(false);
  });
});

describe('onStderrError', () => {
  it('swallows every error (diagnostics channel only)', () => {
    expect(() => onStderrError(codedError('EPIPE'))).not.toThrow();
    expect(() => onStderrError(codedError('EACCES'))).not.toThrow();
  });
});

describe('onStdoutError', () => {
  it('hands the error to the registered handler (server graceful shutdown)', () => {
    const handler = vi.fn();
    setStdoutLostHandler(handler);
    const err = codedError('EPIPE');
    onStdoutError(err);
    expect(handler).toHaveBeenCalledWith(err);
  });

  it('routes non-pipe errors to the handler too — the transport is unusable either way', () => {
    const handler = vi.fn();
    setStdoutLostHandler(handler);
    expect(() => onStdoutError(codedError('EIO'))).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('without a handler, ignores a broken pipe (CLI output piped into a closed reader)', () => {
    expect(() => onStdoutError(codedError('EPIPE'))).not.toThrow();
  });

  it('without a handler, rethrows anything else so the global crash net still sees it', () => {
    const err = codedError('EIO');
    expect(() => onStdoutError(err)).toThrow(err);
  });

  it('setStdoutLostHandler(null) unregisters', () => {
    const handler = vi.fn();
    setStdoutLostHandler(handler);
    setStdoutLostHandler(null);
    onStdoutError(codedError('EPIPE'));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('installStdioGuards', () => {
  it('attaches exactly one error listener per stream, even when called repeatedly', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    installStdioGuards({ stdout, stderr });
    installStdioGuards({ stdout, stderr });
    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
  });

  it('an EPIPE "error" event on a guarded stream no longer throws', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    installStdioGuards({ stdout, stderr });
    // An unguarded EventEmitter throws on emit('error'); guarded ones don't.
    expect(() => stderr.emit('error', codedError('EPIPE'))).not.toThrow();
    expect(() => stdout.emit('error', codedError('EPIPE'))).not.toThrow();
  });

  it('guarded stdout invokes the registered lost-handler', () => {
    const stdout = new EventEmitter();
    installStdioGuards({ stdout });
    const handler = vi.fn();
    setStdoutLostHandler(handler);
    stdout.emit('error', codedError('EPIPE'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing stream', () => {
    expect(() => installStdioGuards({})).not.toThrow();
  });

  it('defaults to the real process streams', () => {
    installStdioGuards();
    const marker = Symbol.for('obsidian-brain.stdio-guard');
    expect((process.stdout as unknown as Record<symbol, unknown>)[marker]).toBe(true);
    expect((process.stderr as unknown as Record<symbol, unknown>)[marker]).toBe(true);
    expect(process.stdout.listeners('error')).toContain(onStdoutError);
    expect(process.stderr.listeners('error')).toContain(onStderrError);
  });
});

describe('routeConsoleToStderr', () => {
  it('sends log/info/debug through console.error', () => {
    const error = vi.fn();
    const fake = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), error } as unknown as Console;
    routeConsoleToStderr(fake);
    fake.log('a', 1);
    fake.info('b');
    fake.debug('c');
    expect(error.mock.calls).toEqual([['a', 1], ['b'], ['c']]);
  });
});
