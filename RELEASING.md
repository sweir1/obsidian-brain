# RELEASING

Local reference for cutting releases of obsidian-brain. Not part of the docs site.

---

## Before you promote

### Preflight runs automatically

As of v1.6.13, `npm run promote` invokes `npm run preflight` as its first step
and aborts before touching main if anything is red. Running preflight manually
first is optional — useful for a fast readiness check without kicking off the
rest of the release flow, but no longer a required pre-step.

```bash
npm run preflight   # optional standalone
```

Preflight runs (in order, mirroring `.github/workflows/ci.yml`): `gen-docs
--check`, `gen-tools-docs --check`, `check-plugin`, `build`, `test:coverage`,
`smoke`, `docs:build` (strict), `codespell`. Streams output live, prints a
pass/fail summary with timings + a git-state footer, exits 1 on any required
failure. `codespell` is best-effort: if the binary isn't on PATH it warns +
skips (install with `pip install codespell`). Every other step is required.

If preflight is green, skip straight to [How to release — one command](#how-to-release--one-command).

### What preflight does not cover (manual)

1. **Add a CHANGELOG entry** for the release at the top of `docs/CHANGELOG.md`.
   Format must match `## vX.Y.Z — YYYY-MM-DD — <title>` exactly — the
   `release.yml` `awk` extractor keys off this pattern (see "CHANGELOG
   conventions" below). Bullet list of user-visible changes underneath.
2. **Prune the roadmap's "Planned / In progress" section** in
   `docs/roadmap.md` if any listed items are now shipping in this release.
   The "Recently shipped" section auto-populates from the CHANGELOG on the
   next docs build — don't touch it.

### Manual equivalent (if you need to run individual steps)

```bash
npm run gen-docs -- --check
npm run gen-tools-docs -- --check
npm run check-plugin
npm run build
npm run test:coverage
npm run smoke
npm run docs:build
codespell docs/ README.md RELEASING.md --skip="*.json,*.lock"
```

The `preversion` hook runs the generators + `check-plugin` automatically when
`npm version` fires, but catching a drift there means `package.json` has
already been bumped, which is noisier to unwind. `preflight` (auto-invoked by
`promote`, or the manual steps) catches it up front.

---

## What `npm version patch|minor|major` does

`npm version <bump>` runs the following sequence:

1. **Bumps `package.json` version.**
2. **Fires the `version` lifecycle hook** (`scripts/sync-server-version.mjs`).
   The script reads `process.env.npm_package_version` (set by npm) and rewrites
   every `"version": "..."` field in `server.json` using a regex replacement
   (not a JSON round-trip, so compact inline formatting is preserved). It then
   runs `git add server.json` so the file is staged alongside `package.json` in
   the version commit.
3. **Creates a git commit** (`chore: vX.Y.Z`) containing `package.json` and `server.json`.
4. **Creates an annotated git tag** `vX.Y.Z`.
5. **Fires the `postversion` lifecycle hook**: `git push --follow-tags`.
   This pushes the version commit **and** the tag in a single call, which is
   what triggers `release.yml` on GitHub Actions.

All of this is driven by the two hooks in `package.json`:

```json
"version":     "node scripts/sync-server-version.mjs && git add server.json",
"postversion": "git push --follow-tags"
```

**Never run `npm version` directly on `dev`.** The `release.yml` workflow has a
main-branch guard (lines 74–82) that checks whether the tagged commit is an
ancestor of `origin/main`. If it isn't, the workflow errors out with an explicit
message and refuses to publish.

---

## How to release — one command

```bash
# Ship up to a specific commit on dev (SHA is required):
npm run promote -- <commit>                  # patch bump
npm run promote -- minor <commit>            # minor bump
npm run promote -- major <commit>            # major bump

# Preview & bypass flags:
npm run promote -- --dry-run <commit>        # preview what would ship
npm run promote -- --skip-preflight <commit> # rare — GHA outage etc.
```

**A `<commit>` argument is required.** `npm run promote` with no SHA exits 1 —
the script refuses to default to dev HEAD so you can't accidentally ship
everything. To ship all of dev, find HEAD and pass it explicitly:

```bash
git log dev --oneline -1
npm run promote -- <that-sha>
```

`<commit>` can be any ref git understands (short SHA, full SHA, tag name, etc.).
It must be on dev's first-parent trunk (i.e., an ancestor of dev HEAD reachable
without following merge-back second-parents) and must be newer than the
`dev-shipped` tag (something not yet shipped).

Args are order-independent: `npm run promote -- abc1234 minor` also works.
Leading dashes on the bump type are optional (`--patch` / `--minor` / `--major`).

### Dry run & preflight bypass

- `--dry-run` runs the assertions, preflight, target resolution, and pending-
  commit computation, then exits before touching main or tagging. Safe preview.
- `--skip-preflight` skips the preflight gate. Don't use casually — preflight
  is the gate that catches CI-failing code before a tag is pushed. Legitimate
  uses: a known-flaky docs-build dep during a GitHub Pages outage, or a hotfix
  where you've manually validated the subset that matters.

### What bump type to pick

`promote` never auto-detects. You choose based on what's in the release:

- **patch** — bug fixes, docs, internal refactors, anything that doesn't
  change tool names, arg shapes, or observable server behavior.
- **minor** — new tools, new optional arg on an existing tool, new env var,
  or any backwards-compatible feature addition.
- **major** — tool renamed or removed, required arg added, env var made
  required, any change that forces users to update their config or prompts.

When in doubt, go patch. Under-bumping means consumers on `@latest` silently
get the update; over-bumping is permanent noise in version history.

### What commit hash to pass

**Always required.** Find what's shippable and pick one:

```bash
# Unshipped commits on dev's first-parent trunk (oldest at bottom):
git log --first-parent --no-merges dev-shipped..dev --oneline

# Or if dev-shipped doesn't exist yet (fresh after cleanup):
git log --first-parent --no-merges origin/main..dev --oneline

# dev HEAD, if shipping everything:
git log dev --oneline -1
```

Then `npm run promote -- <that-sha>`.

Typical cases:

- **Ship everything on dev** → dev HEAD's SHA.
- **Hold back a half-finished feature** → SHA of the last stable commit before
  the feature started. Everything after stays on dev for the next release.
- **Broken commit on top of good work** → SHA before the broken commit. Fix
  the broken one later, ship in a follow-up.

### What `promote` actually does (B5)

1. **Parses args** — bump type + required `<commit>` + optional `--dry-run` / `--skip-preflight`.
2. **Asserts current branch is `dev`** — exits if you're elsewhere.
3. **Asserts a clean working tree** — exits on uncommitted changes.
4. **Fetches origin** to get the current state of both branches.
5. **Runs `npm run preflight`** (unless `--skip-preflight`). Mirrors `ci.yml`:
   gen-docs check, gen-tools-docs check, check-plugin, build, test:coverage,
   smoke, docs:build --strict, codespell. If anything is red, promote aborts.
6. **Resolves the target commit.** Validates it's reachable from dev.
7. **Computes pending commits deterministically** via:
   - `base = refs/tags/dev-shipped` if that tag exists.
   - `base = git merge-base origin/main <target>` otherwise (first promote
     after cleanup; the tag gets seeded once and then tracks every promote).
   - `pending = git log --first-parent --no-merges --reverse base..<target>`.
   This is deterministic — walks dev's first-parent trunk, excludes the
   merge-back commits from prior releases. Replaces the old `git cherry`
   patch-id detection (which broke during v1.6.14 when past cherry-pick
   conflict resolution reshaped commit diffs).
8. **If `--dry-run`, exits** after printing the pending list.
9. **Switches to `main`**, `git pull --ff-only`.
10. **Cherry-picks each pending commit** with `git cherry-pick -x <sha>`. The
    `-x` trailer records the origin SHA in the commit message. On conflict:
    the script exits 1, main left in the conflicted state. Resolve or abort.
11. **Runs `npm version ${bump}`** on main — fires the `version` and
    `postversion` hooks (syncs `server.json`, creates commit + tag, pushes
    main + tag). This triggers `release.yml`.
12. **Merge-back**: checks out dev, `git fetch origin main`, then
    `git merge --no-ff origin/main -m "chore: merge vX.Y.Z into dev"`.
    Merge commit brings main's new tip (cherry-pick twins + version bump)
    onto dev. Plain push to origin/dev — **no force-push**.
13. **Tag update**: `git tag -f dev-shipped <target>`, then
    `git push -f origin refs/tags/dev-shipped`. Tag-only force — rulesets
    apply to `refs/heads/*`, not `refs/tags/*`. Safe.
14. **Prints a summary** — new version, cherry-picked count, final state.

### Force-push accounting

- **Branch force-push**: *never* inside promote. Merge-back is a plain push to dev.
- **Tag force-update** (`refs/tags/dev-shipped`): once per promote. Rulesets
  target branches, not tags — safe.
- **Main**: cannot be force-pushed (`obsidian-brain/main` ruleset: `non_fast_forward`
  + `deletion`, no bypass, not even for you).

### Why this replaced the pure cherry-pick flow

The previous flow left dev and main permanently divergent (29 ahead / 23 behind
by v1.6.13) because cherry-pick rewrites SHAs. Worse: `git cherry`'s patch-id
detection broke whenever past cherry-picks resolved conflicts (producing 7
phantom pending commits during the v1.6.14 attempt, mixing 5 real new commits
with 7 false positives).

B5 fixes both:
- Tag-based pending detection is deterministic; no patch-id reliance.
- Merge-back makes main's tip reachable from dev via the merge commit, so
  GitHub's ancestry-based "behind" counter stays at 0 after every release.

Trade-off: dev's git history becomes a DAG with one merge commit per release.
Main stays strictly linear (enforced by `required_linear_history` ruleset).

---

## Manual / fallback flow (when `promote` breaks)

If `scripts/promote.mjs` fails partway through:

```bash
# 1. Preflight
npm run preflight

# 2. Find pending (deterministic — first-parent walk from dev-shipped)
git fetch origin
git log --first-parent --no-merges --reverse dev-shipped..<target>
# (or: git merge-base origin/main <target> if dev-shipped isn't seeded yet)

# 3. Put main at origin/main
git checkout main && git pull --ff-only origin main

# 4. Cherry-pick each pending commit oldest-first
git cherry-pick -x <sha1> <sha2> ...

# 5. Bump + tag + push (fires version + postversion)
npm version patch                      # or minor/major

# 6. Merge-back to dev (NON-FF — creates a merge commit)
git checkout dev
git fetch origin main
git merge --no-ff origin/main -m "chore: merge v<new-ver> into dev"
git push origin dev                    # PLAIN push, no force

# 7. Update dev-shipped tag
git tag -f dev-shipped <target>
git push -f origin refs/tags/dev-shipped
```

Notes:

- Replace `patch` with `minor` / `major` as needed.
- The `npm version` step fires version + postversion hooks, so main + tag
  push to origin automatically.
- If cherry-pick conflicts, resolve + `git cherry-pick --continue`. If messy,
  `git reset --hard origin/main` and start over.
- If step 6 (merge-back) conflicts, resolve conflicts like any other merge,
  then `git add && git commit`. Standard GitFlow convention expects this
  occasionally — see
  <https://medium.com/@jshvarts/dealing-with-conflicts-when-merging-release-to-develop-da289a572f0d>.
- If step 7 is skipped, the NEXT promote will fall back to `git merge-base`
  computation and re-ship commits already shipped. Always update the tag.

---

## What happens after the tag

Once the tag is pushed, `.github/workflows/release.yml` fires automatically.

### Main-branch guard

The first real step (after checkout) fetches `origin/main` and calls
`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. If the tagged commit
is not on `main`, the workflow exits 1 and publishes nothing.

### Wait for CI to succeed on this SHA

Immediately after the main-branch guard, `release.yml` polls
`gh run list --workflow CI --commit $GITHUB_SHA` for up to 10 minutes.
`ci.yml` fires on the same push as the tag, so both workflows run in parallel;
this step waits for ci.yml to finish, then checks its conclusion. If ci.yml
failed or didn't complete in 10 min, release.yml exits 1 and skips every
downstream publish step (npm, MCP Registry, GitHub Release).

This gates the artefact on the full validation suite (tests+coverage,
docs:build --strict, gen-docs drift, codespell, plugin version check). It's
the canonical "can't ship on red CI" protection regardless of whether
promote or a hand-run created the tag.

Skipped for `workflow_dispatch` (manual publish): the caller is explicitly
overriding the normal path.

### Version sync from tag

The workflow uses `jq` to rewrite `package.json.version` and both
`server.json.version` / `server.json.packages[0].version` from the tag name.
This means even if the files were somehow out of sync when the tag was created,
the published artifact always reflects the tag.

### npm publish (line 145)

```
npm publish --access public
```

Authentication uses **OIDC — no `NPM_TOKEN` secret**. The npmjs.com trusted
publisher is configured once under the package settings (org: `sweir1`, repo:
`obsidian-brain`, workflow: `release.yml`). See the one-time setup comment at
the top of `release.yml`.

### MCP Registry publish (lines 148–159)

Downloads `mcp-publisher` from the MCP Registry releases, authenticates via
`./mcp-publisher login github-oidc` (OIDC, no token), validates `server.json`,
then publishes.

### GitHub Release (lines 161–193)

Release notes are extracted from `docs/CHANGELOG.md` with `awk`:

```awk
/^## v/ {
  inside = ($0 ~ "^## v" ver "( |$|—)")
}
inside
```

This matches the opening `## v${VERSION}` header and captures everything up to
the next `## v` line or EOF.

**The CHANGELOG header format must match exactly:**

```markdown
## vX.Y.Z — YYYY-MM-DD — Title
```

The `awk` pattern anchors on `^## v${VERSION}` followed by a space, end-of-line,
or an em dash (`—`). A header with extra spaces, a different dash character, or
wrong capitalisation will not match, and the release gets a generic fallback note.
See "CHANGELOG conventions" below.

---

## Plugin version-matching

The companion Obsidian plugin lives at `../obsidian-brain-plugin/` (a local
sibling repo, not published on npm). The rule: **major.minor must match**.
Patch versions may drift independently (server at `1.6.3`, plugin at `1.6.1`
is fine; server at `1.7.0` with plugin at `1.6.x` is not).

Bump locations in the plugin repo:

- `manifest.json` — `"version"` field (Obsidian reads this at install time)
- `versions.json` — add a new key for the new version with the minimum Obsidian
  API version it requires

`npm run check-plugin` (added in Phase 3) reads both `./package.json` and
`../obsidian-brain-plugin/manifest.json`, compares major.minor, and exits 1
with a clear message if they differ. It exits 0 with a warning if the plugin
directory doesn't exist (normal in CI where only the server repo is checked out).

---

## HF model cache key

`release.yml` caches the Hugging Face embedding model at (line 127):

```yaml
key: hf-Xenova-bge-small-en-v1.5
restore-keys: hf-Xenova-bge-small-
```

**Only bump the `key` suffix if the default model in
`src/embeddings/presets.ts` changes.** Bumping unnecessarily causes a cold
cache miss on every release run (~60s extra download). The `restore-keys`
prefix `hf-Xenova-bge-small-` is intentionally broad so a key change still
hits a warm partial cache for bge-small variants.

---

## Test coverage

`npm run test:coverage` runs vitest with V8-provider coverage. Reports land
in `coverage/` — open `coverage/index.html` for the per-file drill-down.
The same invocation runs inside `npm run preflight` and inside
`.github/workflows/ci.yml`, so the gate fires locally and in CI from the
same entry point.

### Gate shape

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

### Why branches trails lines — it's structural, not broken

As of v1.6.14: statements 91.6, **branches 81.8**, functions 90.6, lines
92.6. The 10pp gap between lines and branches is textbook for idiomatic
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

**Realistic ceiling for server code: ~85% branches.** A v1.6.14 forensic
audit classified the 268-branch gap at that release: ~61% defensive or
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

### `/* v8 ignore */` policy

Vitest's V8 provider honours `/* v8 ignore next */`, `/* v8 ignore start */
… /* v8 ignore stop */`, and `/* v8 ignore if */` / `/* v8 ignore else */`
directives. They suppress specific branches from the gate when the
branch is **genuinely unreachable**. The policy is narrow by design —
overuse turns the gate into a rubber stamp.

**Legitimate uses:**

- `err instanceof Error ? err.message : String(err)` — the else arm
  only fires for thrown non-Error values (Promise rejection of a bare
  string/number), which no call site in this codebase does. As of
  v1.6.14 this pattern is centralised in `src/util/errors.ts ::
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

**Cap: roughly 10 ignores across the whole codebase.** At v1.6.14
we're at 1 (in `errorMessage`). If this grows past ~10, the gate is
no longer honest — revisit what the thresholds should actually be
instead of paving over individual branches.

### fast-check (property-based testing)

v1.6.14 introduces a property-based testing pilot in
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

### Grandfather mechanism — why `exclude`, not per-file thresholds

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

### Two discipline principles

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

### Manual ratchet

Every few releases, run `npm run test:coverage` and compare the per-file
minimum against the current `thresholds.lines` / `thresholds.branches`
in `vitest.config.ts`. If the minimum has shifted up meaningfully (5pp+),
consider a small PR to raise the thresholds. No urgency — the gate's job
is to catch regressions, not chase the maximum. If the minimum has
*dropped*, investigate *why* before even thinking about lowering the
threshold — the drop is the exact signal the gate was designed to surface.

### Escape hatch

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

---

## Env-var hand-edit

`server.json.packages[0].environmentVariables[]` is **hand-maintained**. It
is the source of truth for the MCP Registry's published manifest and for
`docs/configuration.md` (which regenerates from it via `npm run gen-docs`
once Phase 2 lands).

When adding a new environment variable:

1. Add it to `server.json` under `packages[0].environmentVariables[]`.
2. Add the corresponding read in `src/config.ts`.
3. Run `npm run gen-docs` (Phase 2) to regenerate `docs/configuration.md`.
4. Add it to the PR template checklist entry about env-var edits.

`src/config.ts` drift vs `server.json` is a known remaining edge case (a future
Zod refactor will close it). For now, the PR template checklist is the guard.

---

## Rollback

### Tag not yet picked up by CI (fastest path)

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

Fix the issue on dev, then re-run `npm run promote -- <target-sha>`.

### CI already fired but npm publish failed

Delete the tag as above. No npm action needed — the package was never published.
Re-run `npm run promote -- <target-sha>` once the issue is fixed.

### npm package already published

You cannot unpublish a published npm version (npm policy: unpublish is blocked
after 72 hours, and even within 72 hours it breaks downstream caches). Instead:

```bash
npm deprecate obsidian-brain@vX.Y.Z "reason for deprecation"
```

Then release a follow-up patch (`npm run promote -- <new-target-sha>`) with the
fix. Users on `npx obsidian-brain@latest` will automatically get the patched
version.

If the MCP Registry also published, the follow-up patch release will overwrite
`latest` there too — no manual action needed.

### Merge-back conflict left dev in a weird state

`git merge --abort` on dev resets you to pre-merge. Main has already shipped —
don't reset main. Retry the merge-back manually, resolving conflicts:

```bash
git checkout dev
git fetch origin main
git merge --no-ff origin/main -m "chore: merge vX.Y.Z into dev"
# resolve conflicts, git add, git commit
git push origin dev
git tag -f dev-shipped <target-sha>    # the SHA you passed to promote
git push -f origin refs/tags/dev-shipped
```

---

## Branch protection

GitHub rulesets enforce these invariants server-side. Re-apply any time via
`npm run setup:protection` (idempotent — re-running updates existing rulesets
in place by name rather than duplicating them).

Two rulesets on `main`, one on `dev`. The split exists because GitHub's bypass
actors operate at ruleset granularity, not per-rule: anyone who can bypass a
ruleset bypasses every rule inside it. We want admin to bypass the CI check
(so `promote` can push bump commits) but NOT bypass force-push protection.
Hence two rulesets — one with zero bypass, one with admin bypass.

### `main` (hard rules) — ruleset `obsidian-brain/main`

Nobody bypasses. Not even you.

- **Force-push blocked** (`non_fast_forward`). `git push --force origin main`
  and `git push --force-with-lease origin main` both fail server-side.
- **Deletion blocked** (`deletion`). `git push origin :main` fails.

### `main` (workflow rules) — ruleset `obsidian-brain/main-workflow`

Admin (repo role 5) can bypass rules here via `bypass_mode: always`.
Non-admins cannot.

- **Linear history required** (`required_linear_history`). No merge commits
  on main. `promote` cherry-picks commits (producing linear history) and
  `npm version` adds a linear bump commit — both satisfy this naturally.
  Blocks accidental merge commits onto main.
- **CI must pass** (`required_status_checks` on context `Build, test, smoke,
  docs`). Any PR to main must have a green CI run. Dependabot is the primary
  beneficiary.

The previous `pull_request` rule was removed — it was admin-bypassed in
practice (promote pushes to main directly), so it only created the illusion
of a review gate for the solo workflow. The publish gate lives in
`release.yml`'s "Wait for CI to succeed on this SHA" step instead, which
protects the npm publish regardless of push path.

Why admin bypass on this ruleset: `promote` pushes the bump commit + tag
directly to main. That push hasn't been through CI at push time — CI fires
on the push, concurrently with `release.yml`. Without bypass, `required_status_checks`
would block the push itself. The bypass lets the push land; `release.yml`
then waits for CI to go green before publishing. Dependabot (non-admin)
still has to open a PR and pass CI the normal way.

### `dev` — ruleset `obsidian-brain/dev`

- **Deletion blocked.** `git push origin :dev` fails.
- Force-push is **allowed**. Under B5 `promote` never force-pushes dev (the
  merge-back is a plain push). The one-time cleanup rebase that adopted B5
  is the only documented use of dev force-push. Keeping it allowed is the
  escape hatch for one-off history surgery (e.g. reordering unpushed commits
  before they're referenced). In routine operation, nothing force-pushes dev.

### Defense in depth — why these give you what you asked for

- **"Block force-pushing main"**: `non_fast_forward` in the hard ruleset, no
  bypass. Nobody can rewrite main's history — not even with admin credentials.
- **"Nothing ships to npm unless it came from dev first"**: the `promote`
  script is the only path that produces a tag-bearing push to main, and its
  first assertion is `git rev-parse --abbrev-ref HEAD === 'dev'`. On the
  non-admin side, main pushes require a PR + green CI via
  `required_status_checks`. Dev-first on the admin path is enforced by
  tooling; on the non-admin path it's enforced by GitHub.
- **"Stop it if tests don't pass"**: two layers. At push time,
  `required_status_checks` gates non-admin pushes. At publish time,
  `release.yml`'s "Wait for CI" step gates `npm publish` + MCP Registry +
  GitHub Release on the CI run for the exact tagged SHA — regardless of
  which path produced the tag.
- **"Allow partial cherry-picks from dev"**: `promote -- <sha>` walks dev's
  first-parent trunk from `dev-shipped` to `<sha>`, so you can leave later
  commits unshipped on dev. Subsequent promotes pick up where you left off.

### Emergency escape hatch

If a ruleset ever locks you out of a legitimate operation:

```bash
# Disable one ruleset temporarily (replace NAME):
gh api --method PUT repos/sweir1/obsidian-brain/rulesets/$(
  gh api repos/sweir1/obsidian-brain/rulesets \
    --jq '.[] | select(.name=="obsidian-brain/NAME") | .id'
) -f enforcement=disabled

# Do the operation, then re-enable by re-running the setup:
npm run setup:protection
```

### If CI breaks (temporary)

If CI becomes chronically red for reasons unrelated to the PR being merged
(e.g. HuggingFace model hosting outage), you can temporarily drop the
required-CI rule and keep everything else:

```bash
npm run setup:protection -- --no-ci-check
```

Then re-apply with `npm run setup:protection` once CI stabilises.

---

## CHANGELOG conventions

Every release gets exactly one CHANGELOG entry. Format:

```markdown
## vX.Y.Z — YYYY-MM-DD — Title

- Bullet describing user-visible change.
- Another bullet.
```

Rules:

- **One entry per release.** No "unreleased" section.
- **Header on its own line** with no trailing content after the title.
- **Separator is an em dash** (`—`, U+2014) with a space on each side — not a
  hyphen-minus (`-`) and not an en dash (`–`). The `awk` extractor in
  `release.yml` matches `( |$|—)` after the version number; using the wrong
  dash character means no release notes on GitHub.
- **Bullets, not prose paragraphs.** Short, user-facing, past-tense where
  applicable.
- **Entries in reverse chronological order** (newest at the top).

The `awk` extractor reads from the line matching `^## v${VERSION}` (space, EOF,
or em dash following) up to the next line starting with `## v` or EOF. Everything
between those boundaries becomes the GitHub Release body verbatim.
