import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../src/util/logger.js';

/**
 * Tests for src/util/logger.ts — opt-in NDJSON stderr logger.
 *
 * **How we capture stderr.** The repo's `test/setup/silence-stderr.ts`
 * replaces `process.stderr.write` with a no-op via direct property
 * assignment. `vi.spyOn(process.stderr, 'write')` wraps that no-op for
 * the test's duration and lets us inspect the bytes the logger emitted.
 * `mockRestore()` returns to the silenced no-op (NOT to the real stderr)
 * — that's correct and intentional; the global silencer is meant to
 * persist across all tests.
 */

let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalFormat: string | undefined;

beforeEach(() => {
  originalFormat = process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (originalFormat === undefined) delete process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
  else process.env.OBSIDIAN_BRAIN_LOG_FORMAT = originalFormat;
});

function lastWrite(): string {
  const calls = stderrSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return String(calls[calls.length - 1]![0]);
}

describe('logger — default (plain-text) mode', () => {
  it('emits "obsidian-brain: <message>\\n" when env unset', () => {
    delete process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
    logger.info('hello');
    expect(lastWrite()).toBe('obsidian-brain: hello\n');
  });

  it('emits plain text when env is empty string', () => {
    process.env.OBSIDIAN_BRAIN_LOG_FORMAT = '';
    logger.info('still plain');
    expect(lastWrite()).toBe('obsidian-brain: still plain\n');
  });

  it('ignores fields in plain-text mode (no append)', () => {
    delete process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
    logger.info('indexed', { count: 42, durationMs: 1234 });
    expect(lastWrite()).toBe('obsidian-brain: indexed\n');
  });

  it('warn + error still use plain prefix in default mode', () => {
    delete process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
    logger.warn('careful');
    expect(lastWrite()).toBe('obsidian-brain: careful\n');
    logger.error('boom');
    expect(lastWrite()).toBe('obsidian-brain: boom\n');
  });
});

describe('logger — NDJSON mode', () => {
  beforeEach(() => {
    process.env.OBSIDIAN_BRAIN_LOG_FORMAT = 'ndjson';
  });

  it('emits a single valid JSON line with ts / level / msg', () => {
    logger.info('hello');
    const line = lastWrite();
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(typeof parsed.ts).toBe('string');
    // ISO-8601 with millisecond precision and trailing Z (UTC).
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('merges structured fields alongside ts/level/msg', () => {
    logger.info('indexed', { count: 42, durationMs: 1234, path: 'foo/bar.md' });
    const parsed = JSON.parse(lastWrite().trimEnd());
    expect(parsed.count).toBe(42);
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.path).toBe('foo/bar.md');
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('indexed');
  });

  it('warn and error produce the matching level field', () => {
    logger.warn('soft trouble');
    expect(JSON.parse(lastWrite().trimEnd()).level).toBe('warn');
    logger.error('hard trouble');
    expect(JSON.parse(lastWrite().trimEnd()).level).toBe('error');
  });

  it('escapes control characters in messages (newlines stay valid JSON)', () => {
    logger.info('line1\nline2\twith\ttabs');
    const line = lastWrite();
    // Only one trailing newline — the embedded one must be escaped.
    expect(line.split('\n').length).toBe(2);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.msg).toBe('line1\nline2\twith\ttabs');
  });

  it('canonical envelope keys (ts/level/msg) win over caller-supplied ones', () => {
    // Defensive — caller shouldn't pass these, but if they do we keep the
    // envelope authoritative so log aggregators get consistent shape.
    logger.info('real', { msg: 'fake', level: 'error', ts: 'fake-ts', extra: 1 });
    const parsed = JSON.parse(lastWrite().trimEnd());
    expect(parsed.msg).toBe('real');
    expect(parsed.level).toBe('info');
    expect(parsed.ts).not.toBe('fake-ts');
    expect(parsed.extra).toBe(1);
  });

  it('env is read on every call (toggle between modes within one process)', () => {
    delete process.env.OBSIDIAN_BRAIN_LOG_FORMAT;
    logger.info('plain');
    expect(lastWrite()).toBe('obsidian-brain: plain\n');
    process.env.OBSIDIAN_BRAIN_LOG_FORMAT = 'ndjson';
    logger.info('json');
    const parsed = JSON.parse(lastWrite().trimEnd());
    expect(parsed.msg).toBe('json');
  });
});
