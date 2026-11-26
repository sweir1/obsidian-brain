import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../../src/context.js';

/**
 * src/pipeline/watcher.ts with chokidar mocked out: we capture the options
 * passed to `chokidar.watch` and drive add/change/unlink events by hand.
 * Issue #44 — node ids handed to the indexer must use "/" and dot-folders
 * must be skipped, matching the full reindex. (Windows separators are
 * covered in test/pipeline/watch-paths.test.ts via path.win32.)
 */

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}

const watchCalls: Array<{ target: string; opts: Record<string, unknown>; watcher: FakeWatcher }> = [];

vi.mock('chokidar', () => ({
  default: {
    watch: (target: string, opts: Record<string, unknown>) => {
      const watcher = new FakeWatcher();
      watchCalls.push({ target, opts, watcher });
      return watcher;
    },
  },
}));

const { startWatcher } = await import('../../src/pipeline/watcher.js');

const VAULT = path.resolve('/tmp/ob-watcher-vault');
const abs = (...parts: string[]) => path.join(VAULT, ...parts);

function makeCtx() {
  const indexSingleNote = vi.fn(async (_v: string, _rel: string, event: string) => ({
    indexed: event !== 'unlink',
    skipped: false,
    deleted: event === 'unlink',
    edgesIndexed: 0,
    stubsCreated: event === 'add' ? 1 : 0,
  }));
  const refreshCommunities = vi.fn(() => 3);
  const ensureEmbedderReady = vi.fn(async () => {});
  const ctx = {
    config: { vaultPath: VAULT },
    ensureEmbedderReady,
    pipeline: { indexSingleNote, refreshCommunities },
  } as unknown as ServerContext;
  return { ctx, indexSingleNote, refreshCommunities };
}

beforeEach(() => {
  vi.useFakeTimers();
  watchCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startWatcher', () => {
  it('passes "/"-separated vault-relative ids to the indexer', async () => {
    const { ctx, indexSingleNote } = makeCtx();
    const handle = startWatcher(ctx, { debounceMs: 10, communityDebounceMs: 50 });
    const { watcher } = watchCalls[0]!;

    watcher.emit('change', abs('_logs', '2026-10-15.md'));
    await vi.advanceTimersByTimeAsync(20);

    expect(indexSingleNote).toHaveBeenCalledWith(VAULT, '_logs/2026-10-15.md', 'change');
    await handle.close();
  });

  it('debounces bursts per file and handles add/unlink', async () => {
    const { ctx, indexSingleNote, refreshCommunities } = makeCtx();
    const handle = startWatcher(ctx, { debounceMs: 10, communityDebounceMs: 50 });
    const { watcher } = watchCalls[0]!;

    watcher.emit('change', abs('a.md'));
    watcher.emit('change', abs('a.md'));
    watcher.emit('add', abs('b.md'));
    watcher.emit('unlink', abs('c.md'));
    await vi.advanceTimersByTimeAsync(20);

    expect(indexSingleNote).toHaveBeenCalledTimes(3);
    expect(indexSingleNote.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['a.md', 'change'],
      ['b.md', 'add'],
      ['c.md', 'unlink'],
    ]);

    await vi.advanceTimersByTimeAsync(60);
    expect(refreshCommunities).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('drops events for dot-folders, excluded folders, non-markdown and out-of-vault paths', async () => {
    const { ctx, indexSingleNote } = makeCtx();
    const handle = startWatcher(ctx, { debounceMs: 10 });
    const { watcher } = watchCalls[0]!;

    watcher.emit('add', abs('.claude', 'out.md'));
    watcher.emit('change', abs('.obsidian', 'workspace.md'));
    watcher.emit('change', abs('attachments', 'x.md'));
    watcher.emit('change', abs('img.png'));
    watcher.emit('change', path.resolve('/tmp/elsewhere.md'));
    await vi.advanceTimersByTimeAsync(20);

    expect(indexSingleNote).not.toHaveBeenCalled();
    await handle.close();
  });

  it('wires an `ignored` predicate that skips any dot-folder and keeps notes', async () => {
    const { ctx } = makeCtx();
    const handle = startWatcher(ctx);
    const { target, opts } = watchCalls[0]!;
    const ignored = opts.ignored as (p: string, s?: { isDirectory(): boolean }) => boolean;

    expect(target).toBe(VAULT);
    const dir = { isDirectory: () => true };
    const file = { isDirectory: () => false };
    expect(ignored(abs('.claude'), dir)).toBe(true);
    expect(ignored(abs('.trash'))).toBe(true);
    expect(ignored(abs('Claude outputs'), dir)).toBe(false);
    expect(ignored(abs('Notes', 'a.md'), file)).toBe(false);
    expect(ignored(abs('Notes', 'a.png'), file)).toBe(true);
    await handle.close();
  });

  it('logs indexer failures without throwing and stops scheduling after close', async () => {
    const { ctx, indexSingleNote } = makeCtx();
    indexSingleNote.mockRejectedValueOnce(new Error('boom'));
    const handle = startWatcher(ctx, { debounceMs: 10 });
    const { watcher } = watchCalls[0]!;

    watcher.emit('change', abs('a.md'));
    await vi.advanceTimersByTimeAsync(20);
    expect(indexSingleNote).toHaveBeenCalledTimes(1);

    watcher.emit('change', abs('b.md'));
    await handle.close();
    await vi.advanceTimersByTimeAsync(20);
    expect(indexSingleNote).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalled();

    // Watcher errors are logged, not thrown.
    expect(() => watcher.emit('error', new Error('EMFILE'))).not.toThrow();
  });
});
