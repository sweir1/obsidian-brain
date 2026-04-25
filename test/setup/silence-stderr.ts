/**
 * Vitest setup file — silence production noise during test runs.
 *
 * Silences `process.stderr.write` and `console.warn` / `error` / `log` by
 * monkey-patching the methods directly (NOT via `vi.spyOn`). The direct
 * patch survives any `vi.restoreAllMocks()` / `mockRestore()` calls and
 * catches stderr emitted from async fire-and-forget paths (e.g.
 * `void work().catch(err => process.stderr.write(...))` in
 * `src/tools/background-reindex.ts`) that fire after a test's `afterEach`
 * has already run.
 *
 * Tests that intentionally capture stderr (10 files via
 * `vi.spyOn(process.stderr, 'write')`) keep working: their spy wraps the
 * current noop and replaces its impl with their capture for the test's
 * duration. After the test, vi restores back to the noop, which is
 * exactly what we want — no noise leaks between tests.
 *
 * Override (rare — debugging a specific test that produces stderr you
 * want to see live): set `OBSIDIAN_BRAIN_TEST_STDERR=1` to skip the
 * silencer entirely.
 *
 * Production code paths (per-chunk skip warnings, fault-tolerant indexer
 * summaries, prefetch retry logs, embedder-drift drift-floor lines) are
 * exercised by the test suite and write to stderr unconditionally. That
 * output is informational at runtime and noise at test time. Nothing
 * about the code paths under test changes.
 */

if (process.env.OBSIDIAN_BRAIN_TEST_STDERR !== '1') {
  // Direct property assignment — survives `vi.restoreAllMocks()` and runs
  // for the lifetime of the test file. Tests that spy on these methods
  // get their spy wrapping the no-op below; restore returns to the no-op,
  // not to the real method, which is desirable.
  (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = (() => true);
  // eslint-disable-next-line no-console
  console.log = () => {};
  // eslint-disable-next-line no-console
  console.warn = () => {};
  // eslint-disable-next-line no-console
  console.error = () => {};
}
