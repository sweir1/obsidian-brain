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
Step order (as of v1.6.21):

```
1.  Checkout (full history — needed for the main-ancestor check)
2.  Refuse to publish tags that aren't on main         (push only)
3.  Wait for CI to succeed on this SHA                 (push only)
4.  Resolve version (from tag name or workflow_dispatch input)
5.  Setup Node
6.  Sync versions in package.json + server.json from tag
7.  Install dependencies (npm ci)
8.  Build (tsc → dist/)
9.  Install mcp-publisher                              ← pre-publish validation
10. Validate server.json                               ← PRE-publish gate
11. Publish to npm (OIDC, with provenance)
12. Login to MCP Registry (OIDC)
13. Publish to MCP Registry
14. Create / refresh GitHub Release (mark as latest)
```

`ci.yml` runs the full validation suite (tests+coverage, smoke, docs:build,
gen-docs drift, codespell, plugin version check) on the same commit in
parallel. `release.yml` deliberately **does not** re-run any of that — step
3's CI-gate is the authoritative proof that validation passed, so repeating
it here would be pure duplication.

### Main-branch guard

The first real step (after checkout) fetches `origin/main` and calls
`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. If the tagged commit
is not on `main`, the workflow exits 1 and publishes nothing.

### Wait for CI to succeed on this SHA

Polls `gh run list --workflow CI --commit $GITHUB_SHA` every **10 seconds**,
up to **60 iterations = 10 minutes**. Early-exits on either success (continue)
or any non-success conclusion (refuse, exit 1). If no CI run has concluded
within 10 minutes, the workflow refuses to publish.

Gates the artefact on the full validation suite regardless of whether
promote or a hand-run created the tag. Skipped for `workflow_dispatch`
(manual publish) — that path is an explicit opt-in override.

### Version sync from tag

Uses `jq` to rewrite `package.json.version` and both `server.json.version`
and `server.json.packages[0].version` from the tag name. Defence-in-depth:
under normal B5 flow, the commit already has the right version (`npm version`
set it), so this is a no-op. If the files ever drifted from the tag, this
step is the last-chance correction.

### Install mcp-publisher + Validate server.json (PRE-publish)

mcp-publisher is installed and `./mcp-publisher validate` runs before any
publish happens. If `server.json` fails the MCP Registry schema (e.g. drift
in the hand-maintained `environmentVariables[]` list, see "Env-var hand-edit"
below), the workflow exits 1 and **nothing ships** — no npm tarball, no MCP
Registry entry, no GitHub Release. Matches the `preversion` hook pattern:
check first, mutate second.

Moved earlier in v1.6.21 after v1.6.20 shipped a tarball to npm before
validation ran (the old ordering would have leaked an un-publishable-to-MCP
version onto npm if `server.json` had been malformed — it wasn't, but the
ordering was wrong in principle).

### npm publish

```
npm publish --access public
```

Authentication uses **OIDC — no `NPM_TOKEN` secret**. The npmjs.com trusted
publisher is configured once under the package settings (org: `sweir1`, repo:
`obsidian-brain`, workflow: `release.yml`). See the one-time setup comment at
the top of `release.yml`. Publishes under the `latest` dist-tag — the only
tag we maintain (see "Dist-tag management" below).

### MCP Registry publish

`./mcp-publisher login github-oidc` authenticates via OIDC (no token), then
`./mcp-publisher publish` ships the entry. `server.json` was already validated
pre-publish in step 10, so this step is just "upload the validated manifest".

### GitHub Release

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

## Test coverage (gate summary)

**Every release must pass the coverage gate.** `vitest.config.ts` defines
per-file thresholds (V8 provider) that fire at three checkpoints:

1. **Local preflight** (auto-invoked by `npm run promote`): `npm run test:coverage` must pass. Promote aborts before any push if it fails.
2. **CI** (`.github/workflows/ci.yml`): same `npm run test:coverage` runs on every push to `main` and `dev`. Non-admin PRs cannot merge to main without this green (required status check, no bypass for non-admin roles).
3. **Release gate** (`.github/workflows/release.yml`): waits for CI to go green on the exact tagged SHA before `npm publish` runs. A coverage regression on the tagged commit → nothing ships to npm, MCP Registry, or GitHub Releases.

📖 **You MUST read [`docs/coverage.md`](./docs/coverage.md) before your first release.** It covers everything the gate is actually doing and why:

- **Gate shape**: V8 provider, per-file thresholds, baseline-anchored (NOT aspirational). Why `57`/`37` is the floor.
- **Why branches trails lines** — it's structural (idiomatic TypeScript produces many branches per line), not broken. Realistic ceiling is ~85%.
- **`/* v8 ignore */` policy** — narrow by design. Cap of ~10 ignores across the whole codebase.
- **fast-check (property-based testing)** — pilot in `test/embeddings/chunker.properties.test.ts`.
- **Grandfather mechanism** — why `exclude`, not per-path threshold overrides (vitest 4 limitation).
- **The two discipline principles** — forward (tests must assert) + backward (don't retrofit). The rules that keep the gate from becoming theatre.
- **Manual ratchet** — how and when to bump thresholds.
- **Escape hatch** — what to do when a legitimate refactor drops coverage.

Skipping `docs/coverage.md` is the fastest way to make this gate useless. The discipline principles aren't optional prose; they're the contract that makes coverage measurement mean anything.

---

## Env-var hand-edit

`server.json.packages[0].environmentVariables[]` is **hand-maintained**. It
is the source of truth for the MCP Registry's published manifest and for
`docs/configuration.md` (which regenerates from it via `npm run gen-docs`).

When adding a new environment variable:

1. Add the read in source (`src/config.ts` or wherever the variable is consumed).
2. Add the entry to `server.json` under `packages[0].environmentVariables[]`.
3. Run `npm run gen-docs` to regenerate `docs/configuration.md`.

`npm run check-env-vars` (added v1.7.5; wired into preflight + ci.yml) walks
every `process.env.X` / `env.X` read in `src/` and asserts each one appears
in `server.json` (or on the small `ALLOWLIST` in `scripts/check-env-vars.mjs`
for third-party HF/XDG conventions, legacy aliases, and test-only flags).
Drift fails the gate. This caught the v1.7.5 case where
`OBSIDIAN_BRAIN_REFETCH_METADATA` was added to source but forgotten in the
manifest, silently dropping it from `docs/configuration.md` for one release.

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
- **No real names.** Do not reference reporters, maintainers, reviewers, or
  any individual by name in the CHANGELOG, commit messages, code comments,
  docs, or any other shipped artifact. Describe bugs by symptom and
  scenario, not by who hit them. Made-up personas (e.g. "a user with a
  mixed-language vault") are fine; actual names are not. This applies to
  every committed artifact in the repo, not just the CHANGELOG — commit
  messages travel with the repo and are just as public.

The `awk` extractor reads from the line matching `^## v${VERSION}` (space, EOF,
or em dash following) up to the next line starting with `## v` or EOF. Everything
between those boundaries becomes the GitHub Release body verbatim.
