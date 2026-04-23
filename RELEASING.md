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
# Ship up to a specific commit on dev (the only mode — SHA is required):
npm run promote -- <commit>                  # patch bump, ship up to <commit>
npm run promote -- minor <commit>            # minor bump, ship up to <commit>
npm run promote -- major <commit>            # major bump, ship up to <commit>

# Preview & bypass flags (combine with any of the above):
npm run promote -- --dry-run <commit>        # preview what would ship, no mutation
npm run promote -- --skip-preflight <commit> # bypass preflight (rare — GHA outage, etc.)
```

**A `<commit>` argument is required.** `npm run promote` with no SHA will
exit 1 with an error — the script refuses to default to dev HEAD so you can't
accidentally ship everything on dev with an empty-handed invocation. If you
*do* want to ship all of dev, find HEAD explicitly and pass it:

```bash
git log dev --oneline -1           # look up HEAD's SHA
npm run promote -- <that-sha>      # ship it
```

`<commit>` can be any ref git understands — short SHA, full SHA, tag name. It
must be reachable from `dev` (an ancestor of dev HEAD or dev HEAD itself) and
must be ahead of `main` (something new to ship, by patch-id). Args are
order-independent: `npm run promote -- abc1234 minor` also works. Leading
dashes on the bump type are allowed (`--patch` / `--minor` / `--major`).

### Dry run & preflight bypass

- `--dry-run` runs through the assertions, preflight, target resolution, and
  pending-commit detection, then exits before touching main or tagging. Prints
  the exact list of commits that *would* be cherry-picked. Safe preview.
- `--skip-preflight` skips the preflight gate. Don't use this casually — the
  whole point of preflight is catching CI-failing code before a tag is pushed.
  Legitimate uses: a known-flaky `docs:build` dep during a GitHub Pages outage,
  or a hotfix where you've manually validated the subset that matters.

### What bump type to pick

`promote` never auto-detects. You pick based on what's in the release:

- **patch** — bug fixes, docs, internal refactors, anything that doesn't change
  tool names, arg shapes, or observable server behavior.
- **minor** — new tools, new optional arg on an existing tool, new env var,
  or any feature addition that's backwards-compatible.
- **major** — tool renamed, tool removed, required arg added, env var made
  required, any change that forces users to update their config or prompts.

When in doubt, go patch. The failure mode of under-bumping is that consumers
on `@latest` silently get the update; the failure mode of over-bumping is
permanent noise in the version history.

### What commit hash to pass

**Always required.** The script refuses to default to dev HEAD. Find what's
shippable on dev and pick one:

```bash
git log main..dev --oneline        # lists pending commits, oldest at bottom
git log dev --oneline -1           # dev HEAD (if you want to ship everything)
```

Then:

```bash
npm run promote -- <that-sha>
```

Typical cases:

- **Ship everything on dev** → pass dev HEAD's SHA.
- **Hold back a half-finished feature** → pass the SHA of the last stable
  commit before that feature started. Everything after it stays on dev for
  the next release. Subsequent promotes use stable SHAs (no rebase).
- **Broken commit on top of good work** → pass the SHA before the broken
  commit. Fix the broken one later, ship it in a follow-up.

### What `promote` actually does

1. **Parses args** — bump type + optional commit + `--dry-run` / `--skip-preflight` (order-independent).
2. **Asserts current branch is `dev`** — exits if you're on `main` or elsewhere.
3. **Asserts a clean working tree** — exits on uncommitted changes.
4. **Fetches origin** to get the current state of both branches.
5. **Runs `npm run preflight`** (unless `--skip-preflight`). Mirrors `ci.yml`:
   build + tests + smoke + docs + generated-docs drift + spell check. If
   anything is red, promote aborts before touching main.
6. **Resolves the target commit** (the provided ref, or dev HEAD if none).
   Validates the target is reachable from dev.
7. **Computes pending commits** via `git cherry origin/main <target>`. Commits
   reachable from `<target>` that are not patch-id-equivalent to anything
   already on main get a `+` and are queued for cherry-picking. Commits
   already on main (patch-id match — typically shipped in an earlier promote)
   get `-` and are skipped. Zero tracking refs, zero per-release bookkeeping.
8. **If `--dry-run`, exits here** after printing the pending list.
9. **Switches to `main`**, runs `git pull --ff-only origin main`.
10. **Cherry-picks each pending commit onto main** with `git cherry-pick -x
    <sha>`. The `-x` trailer records the origin SHA in the commit message.
    On conflict: the script exits 1 with a resolution hint, leaving main in
    the conflicted state so you can fix or `--abort`.
11. **Runs `npm version ${bump}`** on main — fires the `version` and
    `postversion` hooks, creating the bump commit + tag and pushing to
    `origin/main`. This is the step that triggers `release.yml`.
12. **Returns to `dev`** — does **not** modify dev, does **not** push dev.
    Dev's SHAs are preserved across every release; you can write down target
    SHAs for a planned multi-release sequence and they'll still be valid
    between steps.
13. **Prints a summary** — new version, cherry-picked count, branch states,
    CI status, and a one-liner for manually syncing dev's `package.json` if
    you want it updated.

Safety: FF-only pulls + patch-id-based pending detection mean the script
either succeeds cleanly or fails without destroying unpublished work. No
`git rebase`, no `--force-with-lease`, no dev history rewrite. If a cherry-
pick fails mid-flight, `main` may be left in the conflicted state — either
resolve and `git cherry-pick --continue` / `npm version <bump>` by hand, or
`git reset --hard origin/main` and re-run promote.

---

## Dev's `package.json` lags main's releases

`npm version` runs on `main`. It bumps `package.json` + `server.json` and tags
that commit. The rework (v1.6.13+) leaves `dev` untouched — so `dev`'s
`package.json` keeps showing whatever version it had before the rework landed,
permanently lagging behind main's latest release.

**This is deliberate and safe.** No code path reads dev's `package.json.version`
at runtime; CI's `release.yml` overrides the version from the tag at publish
time via `jq`. The next promote's patch-id detection doesn't care about
package.json — it looks at commit content, not version numbers.

If you want dev's file synced for cosmetic reasons, one-liner:

```bash
git checkout dev
npm version <new-ver> --no-git-tag-version --allow-same-version
git commit -am "chore: sync dev package.json to v<new-ver>"
git push origin dev
```

This adds one additive linear commit on dev — no force-push, no rebase.

---

## Manual / fallback flow (when `promote` breaks)

If `scripts/promote.mjs` fails partway through, or you need to cut a release
without running it, here is the cherry-pick flow by hand:

```bash
# 1. Pre-flight gate (run the same checks the script would)
npm run preflight

# 2. Find what needs to ship (pending commits, by patch-id)
git fetch origin
git cherry origin/main <target>        # lists "+ <sha>" per pending commit

# 3. Put main where it needs to be
git checkout main && git pull --ff-only origin main

# 4. Cherry-pick each pending commit in order (oldest first)
git cherry-pick -x <sha1> <sha2> ...   # -x records origin in trailer

# 5. Bump + tag + push (fires version + postversion hooks)
npm version patch                      # or minor/major

# 6. Return to dev — NO merge, NO rebase, NO force-push
git checkout dev
```

Notes:

- Replace `patch` with `minor` or `major` as needed.
- The `npm version` step fires the `version` hook (syncs `server.json`) and
  the `postversion` hook (`git push --follow-tags`), so the commit + tag on
  `main` are pushed to origin automatically.
- If a cherry-pick hits a conflict, resolve it, then `git cherry-pick
  --continue`. If things get too messy, `git reset --hard origin/main` on
  main and start over.
- Dev's `package.json` stays at its previous value — deliberate, see the
  "Dev's `package.json` lags" section above. Sync manually if you want.

---

## What happens after the tag

Once the tag is pushed, `.github/workflows/release.yml` fires automatically.

### Main-branch guard (lines 74–82)

The first real step (after checkout) fetches `origin/main` and calls
`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. If the tagged commit
is not on `main`, the workflow exits 1 with a clear error message and publishes
nothing.

### Version sync from tag (lines 105–117)

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

### Forgot the merge-back to `dev`

Not a rollback — just a sync. If `dev` still shows the old version after a
release, see "Why does dev's `package.json` only bump after the release?"
above. One-liner: `git checkout dev && git pull origin main && git push origin dev`.

### Tag not yet picked up by CI (fastest path)

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

Fix the issue, then re-run `npm run promote`.

### CI already fired but npm publish failed

Delete the tag as above. No npm action needed — the package was never published.
Re-run `npm run promote` once the issue is fixed.

### npm package already published

You cannot unpublish a published npm version (npm policy: unpublish is blocked
after 72 hours, and even within 72 hours it breaks downstream caches). Instead:

```bash
npm deprecate obsidian-brain@vX.Y.Z "reason for deprecation"
```

Then release a follow-up patch (`npm run promote`) with the fix. Users on
`npx obsidian-brain@latest` will automatically get the patched version.

If the MCP Registry also published, the follow-up patch release will overwrite
`latest` there too — no manual action needed.

---

## Worktree-agent branches

Prior Claude Code Agent sessions run with `isolation: "worktree"` left two
local-only branches:

```bash
git branch -d worktree-agent-a4249980 worktree-agent-a6352c02
```

These were never pushed to `origin`. Safe to delete any time.

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

Admin (repo role 5) can bypass all rules here via `bypass_mode: always`.
Non-admins (Dependabot, future contributors) cannot.

- **Linear history required** (`required_linear_history`). No merge commits
  on main. `promote` uses `git merge --ff-only` throughout so it satisfies
  this naturally. Blocks the footgun of `git merge dev` without `--ff-only`
  landing a merge commit, and forces PR merges to use squash or rebase.
- **Pull request required** (`pull_request`, 0 approvals). Any non-admin
  change to main must go through a PR. Direct `git push origin main` from
  a write-access collaborator is blocked. Required approvals is 0 (solo
  workflow); bump this via the script if you add reviewers.
- **CI must pass** (`required_status_checks` on context `Build, test, smoke,
  docs`). PRs cannot merge to main unless the CI workflow succeeds on the
  PR's head commit. Dependabot PRs are the primary beneficiary — any update
  that breaks the build, tests, smoke, or docs is caught here.

Why admin bypass: `promote` creates a bump commit locally via `npm version`
and pushes it directly to main. That commit has never been through CI at
push time, AND it isn't introduced via a PR — so without bypass the
pull_request AND required-status-checks rules would both block it. The
bypass lets the admin push go through. Dependabot (non-admin) still has
to open a PR and pass CI the normal way.

### `dev` — ruleset `obsidian-brain/dev`

- **Deletion blocked.** `git push origin :dev` fails.
- Force-push is **allowed**. Historical reason: pre-v1.6.13 the cherry-pick
  branch of `promote` rebased dev onto main and force-pushed with
  `--force-with-lease`. As of v1.6.13 the script never touches dev, so
  `promote` no longer *uses* force-push. Keeping it allowed is intentional:
  one-off history surgery (reordering unpushed commits, dropping a bad
  commit before it's referenced) still needs the escape hatch.

### Defense in depth — why these give you what you asked for

- **"Block force-pushing main"**: `non_fast_forward` in the hard ruleset, no
  bypass. Nobody can rewrite main's history — not even with admin credentials.
- **"Nobody can push to main unless it came from dev first"**: `pull_request`
  (workflow ruleset) blocks direct pushes from non-admin actors. Admin can
  bypass specifically for the `promote` flow, which itself asserts current
  branch is dev and FF-merges from dev. So: non-admin ⇒ must PR (CI gates
  merge); admin ⇒ only `promote` does direct pushes, and `promote`'s first
  assertion is `git rev-parse --abbrev-ref HEAD === 'dev'`. Dev-first is
  enforced by tooling on the admin path and by GitHub on the non-admin path.
- **"Stop it if tests don't pass"**: `required_status_checks` (workflow
  ruleset) — Dependabot and contributor PRs need green CI to merge. Admin
  bypass covers `promote`'s direct-push (the bump commit that has no CI run
  yet); the bump commit itself runs tests once it reaches main via `ci.yml`.
- **"Allow cherry-picks"**: cherry-picked commits travel either through
  `promote -- <commit-sha>` (admin path, works via bypass) or through a
  PR (non-admin path, passes CI like any other PR). Both paths land the
  cherry-pick on main cleanly.

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
