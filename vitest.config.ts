import { defineConfig } from 'vitest/config';

// Coverage configuration. See the "Test coverage" section in RELEASING.md
// for policy (baseline-anchored, per-file, V8 provider, not a target).
//
// Gate mechanics:
//   - perFile: true → every file must independently meet the threshold.
//     Global average gating would let a 0%-covered new module sit next
//     to a 99%-covered existing module and pass unnoticed. Per-file forces
//     the gap to surface.
//   - thresholds.lines / branches → baseline-anchored (per-file-minimum
//     among non-grandfathered files, minus 3pp for refactor tolerance).
//     NOT an aspirational target. Anchor shifts only via deliberate manual
//     ratchet, never by autoUpdate.
//   - Per-path overrides (below) handle specific legitimate cases where
//     coverage-as-reported is a partial signal, not a floor for total code.

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Explicit exclude so the locally-cloned upstream reference/ dir never
    // gets picked up even if someone widens `include` later.
    exclude: ['**/node_modules/**', '**/dist/**', 'reference/**'],
    // v1.7.5: silence production stderr writes by default during tests so
    // the run output stays clean. Tests that assert on stderr content via
    // `vi.spyOn(process.stderr, 'write')` continue to work — their spy
    // overrides the no-op for the test's duration. Set
    // OBSIDIAN_BRAIN_TEST_STDERR=1 to disable the silencer when debugging.
    setupFiles: ['./test/setup/silence-stderr.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      // Include completely-untested files in the report (e.g. src/cli/index.ts
      // currently). Without `all: true`, untested files are invisible — which
      // defeats the "surface the gap" point of enforcement. Vitest 4's default
      // is true, but silent default-flips across majors are a real vector, so
      // set explicitly.
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        // Type-only files. No runtime code, always 0% by construction.
        // Glob covers future type-dump files anywhere under src/.
        '**/types.ts',
        '**/*.d.ts',

        // ---- Grandfathered-from-coverage files ----
        //
        // Note on the mechanism: in vitest 4, global `thresholds.lines` /
        // `thresholds.branches` apply to every file regardless of any
        // per-path threshold overrides (see vitest source comment:
        // "Global threshold is for all files, even if they are included
        // by glob patterns"). Per-path overrides can only ADD thresholds,
        // not remove them. The only way to exempt a specific file from
        // the global threshold is to exclude it from coverage entirely.
        //
        // This list surfaces the gaps explicitly: each entry names a file
        // that IS currently untested (or untestable at unit level with
        // existing infrastructure) and SHOULD have tests. Removing an
        // entry requires writing the test first and confirming the file
        // clears the global floor. See RELEASING.md → "Test coverage"
        // for the discipline principles.

        // All grandfather excludes use `**/`-prefixed globs so they're
        // portable regardless of how the path is normalized internally
        // (absolute vs relative, cwd differences between local and CI).
        // Bare paths CAN work but are fragile to internal path handling
        // changes between vitest versions; the wildcard form is robust.

        // Untested legacy CLI entrypoint. No test/cli/ exists.
        // TODO: write test/cli/index.test.ts, remove this exclusion.
        '**/src/cli/index.ts',

        // v1.7.7: native-module preflight runs at process startup, BEFORE
        // any user code or test setup is on the stack. Unit-testing it
        // requires mocking createRequire + writeSync + the auto-heal
        // module, then asserting on process.exit() side effects — doable
        // but high-noise vs benefit. The auto-heal logic it dispatches to
        // IS unit-tested via test/auto-heal.test.ts +
        // test/context.test.ts. Coverage on this glue file would be
        // performative rather than meaningful.
        // TODO: write test/preflight.test.ts that mocks the require_ +
        // auto-heal pair if a future bug surfaces in the dispatch logic.
        '**/src/preflight.ts',

        // v1.7.7: createContext() now contains ONLY the hard-to-test glue
        // (vault path resolution, DB open + native module load, embedder
        // factory wiring, search/writer/pipeline construction). The
        // well-tested auto-heal block was extracted to src/auto-heal.ts
        // (covered by test/auto-heal.test.ts). What remains in context.ts
        // is exercised end-to-end by the smoke test
        // (scripts/mcp-smoke.ts) and by test/integration/* but those
        // spawn real subprocesses that V8 coverage can't follow into.
        // TODO: add a vitest-level integration test that constructs a
        // ServerContext against a real temp vault + DB and exercises the
        // remaining branches.
        '**/src/context.ts',

        // Subprocess blind spot — V8 coverage does NOT follow into child
        // processes. Signal handlers, main-entry guards, stdin-EOF shutdown
        // (v1.6.8), and orderly-native-teardown code in src/server.ts are
        // exercised ONLY by test/integration/server-stdin-shutdown.test.ts,
        // which spawns a real subprocess. Those lines are always reported
        // as uncovered regardless of whether they're actually tested.
        // Coverage is the wrong instrument for this file's correctness —
        // the subprocess test IS the gate for this code. If the file is
        // ever refactored so a meaningful portion becomes in-process
        // testable, remove this exclusion and set a real threshold.
        '**/src/server.ts',

        // Watcher — genuinely untested. No test/pipeline/watcher.test.ts
        // exists. Real gap surfaced by baseline.
        // TODO: write test/pipeline/watcher.test.ts, remove exclusion.
        '**/src/pipeline/watcher.ts',

        // Plugin-dependent tools. These only work when the Obsidian
        // companion plugin is running (server talks to it over localhost
        // HTTP). Meaningful unit tests require mocking the plugin HTTP
        // contract, which nobody's written yet.
        // TODO: add mocked plugin HTTP contract helper, write per-tool
        // unit tests, remove each exclusion individually as tests land.
        '**/src/tools/active-note.ts',
        '**/src/tools/base-query.ts',
        '**/src/tools/dataview-query.ts',

        // Surprisingly untested — test/graph/pathfinding.test.ts covers
        // the underlying graph primitive but the tool wrapper itself has
        // no direct test. Mirror test/tools/rank-notes.test.ts pattern.
        // TODO: write test/tools/find-path-between.test.ts, remove exclusion.
        '**/src/tools/find-path-between.ts',
      ],
      thresholds: {
        perFile: true,
        // Baseline-anchored (see RELEASING.md → "Test coverage"). Floor is
        // per-file-minimum among NON-EXCLUDED files, minus 3pp for
        // refactor tolerance:
        //   - lines 60.8 (src/context.ts) - 3 ≈ 57
        //   - branches 40.0 (src/tools/link-notes.ts, edit-note.ts) - 3 ≈ 37
        //
        // Manual ratchet: raise these in a small PR when baseline minimums
        // shift up meaningfully (5pp+). Never autoUpdate — see why-not
        // in the approved plan.
        //
        // Grandfather files that can't meet this floor via `exclude`
        // above, not via per-path thresholds (which don't replace the
        // global — see comment on the exclude list).
        lines: 57,
        branches: 37,
      },
    },
  },
});
