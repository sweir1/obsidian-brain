---
title: Test coverage
description: Coverage-gate discipline, V8 provider rationale, /* v8 ignore */ policy, fast-check pilot, grandfather mechanism.
---

# Test coverage

This doc is the discipline reference for the coverage gate enforced at three points: local preflight (`npm run preflight`), CI (`ci.yml`), and the release gate (`release.yml` waits for CI green before publishing). Read it end-to-end before your first real release — the discipline principles (forward + backward) are what keep the gate from becoming theatre.

`npm run test:coverage` runs vitest with V8-provider coverage. Reports land
in `coverage/` — open `coverage/index.html` for the per-file drill-down.
The same invocation runs inside `npm run preflight` and inside
`.github/workflows/ci.yml`, so the gate fires locally and in CI from the
same entry point.

## Gate shape

- **Provider**: V8 (`@vitest/coverage-v8`). ~10% runtime overhead vs
  Istanbul's 20–40%. Accurate enough for this codebase's imperative glue.
  Under Vitest 3.2+ the provider uses AST-based V8-to-Istanbul remapping
  ([3.2 blog](https://vitest.dev/blog/vitest-3-2.html)); Vitest 4.x removes
  the old heuristic path entirely and makes AST the only mode
  ([v4 migration](https://vitest.dev/guide/migration.html)). So the V8
  numbers reported here are AST-accurate, not the inflated ones from
  pre-3.2.
- **Per-file** (`thresholds.perFile: true`). Every file must independently
  meet the bar — global averages would let a 0%-covered new module sit
  next to a 99%-covered existing module and pass unnoticed. The gate is
  supposed to surface gaps, not hide them in averages.
- **Anchor**: baseline-minimum minus 3pp (refactor tolerance). NOT an
  aspirational target. Arbitrary "80%" thresholds invite coverage
  theatre; anchoring to observed minimums catches regressions without
  demanding a made-up number.
- **Metrics gated**: `lines` + `branches` at 57% / 37% (baseline-min
  minus 3pp). `statements` ≈ `lines`, `functions` tracks lines closely —
  gating all four over-constrains.

## Why branches trails lines — it's structural, not broken

Recent baseline: statements ~91, **branches ~82**, functions ~90, lines
~92. The 10pp gap between lines and branches is textbook for idiomatic
TypeScript and isn't going anywhere. Every decision point — `if/else`,
ternary, `??`, `?.`, `||`, `&&`, `switch` case, default parameter,
destructuring default — counts as multiple branches. A single line like
`const name = user?.profile?.name ?? 'anon'` produces 5 branches per 1
line. Happy-path tests give 100% lines and ~40% branches on that line
alone.

See [Codecov](https://about.codecov.io/blog/line-or-branch-coverage-which-type-is-right-for-you/)
and [Ardalis](https://ardalis.com/which-is-more-important-line-coverage-or-branch-coverage/)
for the standard explanations. A 10–20pp lines-vs-branches gap is
textbook for real codebases.

**Realistic ceiling for server code: ~85% branches.** A forensic
audit classified a recent ~268-branch gap: ~61% defensive or
unreachable (`catch` arms, `err instanceof Error` else-arms, null guards
on already-validated Zod objects, ABI-heal messaging), ~30%
truthy/falsy shortcuts where one side is legitimately untested,
~9% real untested behaviour worth writing tests for. Chasing the
defensive 61% with contrived tests is exactly the coverage theatre the
two discipline principles below exist to prevent.

**Aspirational targets (documented, NOT enforced):** 85% branches /
92% lines. Per-file floors in the config stay baseline-anchored —
aspirational targets live in docs where they can't cause whack-a-mole
CI failures.

## `/* v8 ignore */` policy

Vitest's V8 provider honours `/* v8 ignore next */`, `/* v8 ignore start */
… /* v8 ignore stop */`, and `/* v8 ignore if */` / `/* v8 ignore else */`
directives. They suppress specific branches from the gate when the
branch is **genuinely unreachable**. The policy is narrow by design —
overuse turns the gate into a rubber stamp.

**Legitimate uses:**

- `err instanceof Error ? err.message : String(err)` — the else arm
  only fires for thrown non-Error values (Promise rejection of a bare
  string/number), which no call site in this codebase does. The
  pattern is centralised in `src/util/errors.ts ::
  errorMessage(err)` with a single ignore on the fallback — nine
  duplicated sites collapse into one.
- `const x = options?.foo ?? default` where `options` is a validated
  Zod-shape object and `.foo` is required — the nullish branch can't
  fire.
- `throw new Error('unreachable')` in exhaustive-switch defaults.

**Illegitimate uses:** masking a `catch` block that could genuinely
fire (FS errors, HTTP errors, DB errors), masking an `if` branch on
user-facing input, or masking anything you haven't proven unreachable
from first principles.

**Every ignore gets a one-line rationale comment** on the same line
or the line above, explaining specifically why the branch is
unreachable. If the rationale doesn't fit on one line, the branch
probably isn't unreachable and you're about to ship theatre.

**Cap: roughly 10 ignores across the whole codebase.** Current count
is 1 (in `errorMessage`). If this grows past ~10, the gate is
no longer honest — revisit what the thresholds should actually be
instead of paving over individual branches.

## fast-check (property-based testing)

A property-based testing pilot lives in
`test/embeddings/chunker.properties.test.ts` using `fast-check`. Three
invariants are checked over 500 total random markdown documents:

- `chunkIndex` values are contiguous `[0, 1, …, n-1]`.
- No chunk's `content` leaks a raw Unicode PUA protect-sentinel.
- Every fenced code block appears intact in exactly one chunk.

Cost: <1 second added to the test run. Example-based tests stay
primary; property tests are a complementary layer for high-complexity
modules where edge cases are impossible to enumerate by hand.

**Expansion candidates** (deferred until the chunker pilot proves its
value): `src/vault/wiki-links.ts` `rewriteWikiLinks` round-trip
invariant, `src/store/fts5-escape.ts` MATCH-syntax validity across
arbitrary Unicode inputs. Not a race — add a module at a time when the
marginal test volume justifies it.

## Grandfather mechanism — why `exclude`, not per-file thresholds

**Discovered during implementation and worth spelling out clearly**: in
vitest 4, per-path threshold overrides (globs as keys inside
`thresholds: {}`) **cannot exempt a file from the global floor**. They
can only *add* additional thresholds on top of the globals. The vitest
source is explicit (`coverage.DM_a_rWm.js:838`): "Global threshold is
for all files, even if they are included by glob patterns." This is a
long-standing behaviour mismatch with Jest; tracked at
[vitest-dev/vitest#6165](https://github.com/vitest-dev/vitest/issues/6165).

Consequence: the **only** mechanism in vitest 4 to exempt a specific
file from the global coverage floor is `coverage.exclude`. Per-path
threshold keys are the right tool for *raising* the bar on a
well-tested subset, never for *lowering* it.

Files currently grandfathered via `coverage.exclude` in
`vitest.config.ts` (each with a TODO comment pointing at the follow-up
PR that adds tests + removes the exclusion):

- **`src/cli/index.ts`** — untested legacy CLI entrypoint, no
  `test/cli/` directory exists.
- **`src/server.ts`** — subprocess blind spot. Signal handlers,
  `stdin-EOF` shutdown, and orderly-native-teardown are exercised
  ONLY by `test/integration/server-stdin-shutdown.test.ts`, which
  spawns a real subprocess that V8 coverage doesn't follow into.
  Coverage is the *wrong instrument* for this file's correctness —
  the subprocess test IS the gate for that code.
- **`src/pipeline/watcher.ts`** — genuinely untested; real gap
  surfaced by baseline measurement.
- **`src/tools/active-note.ts`** / **`base-query.ts`** /
  **`dataview-query.ts`** — plugin-dependent tools, require mocked
  Obsidian plugin HTTP contract which nobody's written.
- **`src/tools/find-path-between.ts`** — the underlying graph
  primitive is tested in `test/graph/pathfinding.test.ts` but the
  tool wrapper itself has no direct test.

Trade-off of `exclude`-based grandfathering: excluded files do NOT
appear in the HTML coverage report. The "hidden gap" cost is
mitigated by listing each exclusion explicitly in `vitest.config.ts`
with rationale + TODO — gaps surface in code review and in the
config file, not in the report. For a solo project that's the right
trade; the philosophical "surface gaps in the report" path isn't
available in vitest 4.

## Two discipline principles

These are the rules that keep coverage-as-a-gate from becoming
coverage-theatre. Both are worth naming separately because they're
different failure modes:

- **Forward discipline — new tests must actually assert behaviour.**
  Don't write `expect(x).toBeDefined()`-style tests to trip the meter
  for new code. A test that hits a line without asserting anything is
  net-negative: it adds coverage (false confidence) without adding
  protection. Tests are supposed to fail when the behaviour they
  describe breaks. If a test can't fail, it's noise.
- **Backward discipline — don't retrofit existing tests to raise
  numbers.** If the coverage baseline surfaces an untested module, the
  response is a follow-up PR that writes *real new tests* for that
  gap — not assertion-pumping an existing `chunker.test.ts` until its
  branch count goes up. The baseline tells you where the gaps are; the
  gaps get filled by tests that assert real behaviour, in their own
  commits, not by dilating unrelated tests.

## Manual ratchet

Every few releases, run `npm run test:coverage` and compare the per-file
minimum against the current `thresholds.lines` / `thresholds.branches`
in `vitest.config.ts`. If the minimum has shifted up meaningfully (5pp+),
consider a small PR to raise the thresholds. No urgency — the gate's job
is to catch regressions, not chase the maximum. If the minimum has
*dropped*, investigate *why* before even thinking about lowering the
threshold — the drop is the exact signal the gate was designed to surface.

## Escape hatch

If a legitimate refactor drops per-file coverage below threshold and
blocks a PR, three paths, in order of preference:

1. **Write the missing test** in the same PR. Usually the right answer
   — the refactor moved or restructured code, and a small test addition
   covers the new shape.
2. **Adjust the global threshold** in the same PR, with a commit
   message explaining why the drop is intentional (e.g. "deleted dead
   code path; coverage numerator shrank but denominator shrank less").
   Rare but legitimate. Prefer over option 3 because it's a smaller
   commit.
3. **Add the file to `coverage.exclude`** in `vitest.config.ts` with a
   rationale comment + TODO. Use only for genuine tooling-blind-spot
   cases like `src/server.ts`'s subprocess-only code, or for code whose
   test requires infrastructure that doesn't yet exist (like the
   plugin-HTTP mocks for `src/tools/base-query.ts`). **Not** as a
   general "I'll write tests later" exemption — each exclusion is a
   visible gap the TODO surfaces for future work.

What **doesn't** work: adding a per-path threshold override in
`thresholds: { '**/foo.ts': { lines: 0 } }`. Per-path overrides in
vitest 4 can only *raise* the bar — they do NOT remove the global
floor from matched files. See the "Grandfather mechanism" section
above for why.
