/**
 * v1.7.23 Fix 4a: focused unit test for the SIGTERM-before-ctx-initialized
 * race fixed in `046f226`. Pre-fix, SIGTERM/SIGINT handlers were registered
 * AFTER `await createContext()`. On a cold Linux CI runner, createContext
 * (which dlopens better-sqlite3 + sqlite-vec) took ~1s — long enough for a
 * test's `SIGTERM` to arrive before any handler was armed, defaulting to
 * kernel signal-kill (exit code: null, signal: 'SIGTERM').
 *
 * Post-fix: `startServer()` registers handlers at the very top of the
 * function, BEFORE any `await`. The shutdown closure captures `ctx`/`handle`
 * via `let` bindings that may be null during the createContext phase; null
 * guards in the shutdown handler make that branch a no-op cleanup that still
 * reaches `process.exit(0)`.
 *
 * This test stubs `createContext` to hang forever, calls `startServer()`,
 * and asserts that SIGTERM handler is armed before the await would resolve.
 * The existing `test/integration/server-stdin-shutdown.test.ts:73` v1.6.10
 * test covers the end-to-end exit-cleanly path; this unit test specifically
 * locks in the "armed pre-await" invariant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startServer — SIGTERM handler arm timing (v1.7.23 race fix)', () => {
  let initialSigtermCount: number;
  let initialSigintCount: number;
  let serverPromise: Promise<unknown> | null = null;

  beforeEach(() => {
    initialSigtermCount = process.listenerCount('SIGTERM');
    initialSigintCount = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    // Cleanly remove any SIGTERM/SIGINT listener the test added so it doesn't
    // leak into subsequent tests. The handler is anonymous so we remove all
    // listeners added beyond the baseline count.
    const sigtermListeners = process.listeners('SIGTERM');
    for (let i = sigtermListeners.length - 1; i >= initialSigtermCount; i--) {
      process.off('SIGTERM', sigtermListeners[i]);
    }
    const sigintListeners = process.listeners('SIGINT');
    for (let i = sigintListeners.length - 1; i >= initialSigintCount; i--) {
      process.off('SIGINT', sigintListeners[i]);
    }
    // Detach from the hanging createContext promise so the test isn't held open.
    serverPromise = null;
    vi.restoreAllMocks();
  });

  it('arms SIGTERM and SIGINT handlers BEFORE createContext resolves', async () => {
    // Use dynamic import + vi.doMock so the mock is in place before `startServer`
    // resolves the `./context.js` import. createContext returns a promise that
    // NEVER resolves — simulating a slow Linux-CI cold-boot dlopen.
    vi.doMock('../src/context.js', () => ({
      createContext: vi.fn(() => new Promise(() => {})),
    }));

    // Import startServer AFTER doMock so the mocked module is used.
    const { startServer } = await import('../src/server.js');

    // Kick off startServer — it will await the never-resolving createContext.
    // We don't await `serverPromise` itself; the assertion runs while it hangs.
    serverPromise = startServer().catch((err) => {
      // Swallow any teardown errors so afterEach can clean up.
      return err;
    });

    // Yield to the event loop so the synchronous handler-registration block
    // at the top of startServer runs. The pre-v1.7.22-fix code would NOT have
    // armed the handler at this point because it was waiting on createContext.
    await new Promise((resolve) => setImmediate(resolve));

    // The fix: SIGTERM/SIGINT each get exactly one new listener.
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);
  });

  it('shutdown handler runs without throwing when ctx is still null', async () => {
    // Same setup: createContext hangs forever.
    vi.doMock('../src/context.js', () => ({
      createContext: vi.fn(() => new Promise(() => {})),
    }));
    const { startServer } = await import('../src/server.js');
    serverPromise = startServer().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    // Capture the new SIGTERM handler (the one startServer just added).
    const sigtermListeners = process.listeners('SIGTERM');
    const handler = sigtermListeners[sigtermListeners.length - 1];
    expect(handler).toBeDefined();

    // Spy on process.exit so the test doesn't kill itself.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Call the handler with no signal arg (the handler ignores it). The
    // shutdown closure's `if (ctx)` and `if (handle)` null guards must
    // skip all ctx-dependent cleanup and reach the exitCode/setTimeout
    // tail without throwing.
    expect(() => handler('SIGTERM')).not.toThrow();

    // Let the next microtask tick — the shutdown handler is async so
    // its inner try/catch runs after.
    await new Promise((resolve) => setImmediate(resolve));

    // process.exitCode is set to 0 before the setTimeout fallback fires.
    // The unref()'d setTimeout doesn't actually trigger in test context.
    expect(process.exitCode).toBe(0);

    exitSpy.mockRestore();
    // Reset exitCode so it doesn't leak.
    process.exitCode = 0;
  });
});
