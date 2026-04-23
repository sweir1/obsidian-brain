# RELEASING

Local reference for cutting releases of obsidian-brain. Not part of the docs site.

---

## Before you promote

Run through this list before invoking `npm run promote`. None of these are
enforced by the script — the `preversion` hook catches the generator checks,
but catching a drift there means `npm version` has already bumped
`package.json`, which is noisier to unwind.

1. **Add a CHANGELOG entry** for the release at the top of `docs/CHANGELOG.md`.
   Format must match `## vX.Y.Z — YYYY-MM-DD — <title>` exactly — the
   `release.yml` `awk` extractor keys off this pattern (see "CHANGELOG
   conventions" below). Bullet list of user-visible changes underneath.
2. **Prune the roadmap's "Planned / In progress" section** in
   `docs/roadmap.md` if any listed items are now shipping in this release.
   The "Recently shipped" section auto-populates from the CHANGELOG on the
   next docs build — don't touch it.
3. **Confirm the generators are in sync**:
   ```bash
   npm run gen-docs -- --check
   npm run gen-tools-docs -- --check
   ```
   Both should exit 0. The `preversion` hook runs these too, but checking
   up front is cheaper than debugging a failed `npm version`.
4. **Confirm plugin version-matching**:
   ```bash
   npm run check-plugin
   ```
   Exits 0 if `../obsidian-brain-plugin/manifest.json` major.minor matches
   `./package.json`. See "Plugin version-matching" below.

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
# Ship everything on dev (common case):
npm run promote                       # patch bump  (default)
npm run promote -- minor              # minor bump
npm run promote -- major              # major bump

# Ship only up to a specific commit on dev (cherry-pick release):
npm run promote -- <commit>           # patch bump, ship up to <commit>
npm run promote -- minor <commit>     # minor bump, ship up to <commit>
npm run promote -- major <commit>     # major bump, ship up to <commit>
```

`<commit>` can be any ref git understands — short SHA, full SHA, tag name. It
must be reachable from `dev` (an ancestor of dev HEAD) and must be ahead of
`main` (something new to ship). Args are order-independent: `npm run promote
-- abc1234 minor` also works. Leading dashes on the bump type are allowed
(`--patch` / `--minor` / `--major`).

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

### What commit hash to pass (and when)

**Default case: don't pass one.** `npm run promote` ships everything on dev.
That's the 95% case.

**Pass a commit only when** dev has work you want to hold back. Typical reasons:

- "I want to ship the bugfix commit now but hold the half-finished feature."
- "A later commit on dev has issues I haven't fixed — ship the earlier stable
  commit, keep the broken one on dev for now."

Find the commit with `git log main..dev --oneline`, grab its short SHA, pass it.

### What `promote` actually does

1. **Parses args** — bump type + optional commit (order-independent).
2. **Asserts current branch is `dev`** — exits if you're on `main` or elsewhere.
3. **Asserts a clean working tree** — exits on uncommitted changes.
4. **Fetches origin** to get the current state of both branches.
5. **Resolves the target commit** (the provided ref, or dev HEAD if none).
   Validates the target is reachable from dev and is ahead of main.
6. **Runs `npm run check-plugin`** if the script exists in `package.json`.
   See "Plugin version-matching" below.
7. **Switches to `main`**, runs `git pull --ff-only origin main`.
8. **Merges target into main** with `git merge --ff-only <target>`. If the
   merge cannot be completed as a fast-forward (main has diverged), the
   script fails loudly rather than creating a merge commit.
9. **Runs `npm version ${bump}`** — fires the `version` and `postversion`
   hooks, creating the version commit + tag and pushing to `origin/main`.
   This is the step that triggers `release.yml`.
10. **Returns to `dev`** and syncs:
    - **Full-ship case** (target was dev HEAD): `git merge --ff-only main`
      fast-forwards dev to include the bump commit, then `git push origin dev`.
    - **Cherry-pick case** (target was older than dev HEAD): dev has commits
      beyond the promoted target, so main and dev have diverged. The script
      runs `git rebase main`, replaying dev's extra commits on top of the
      bump commit, then `git push --force-with-lease origin dev`. **This
      rewrites dev history.** Fine for solo work; coordinate if you share
      dev with anyone else.
11. **Prints a summary** — new version, tagged commit, branch states, CI status.

Safety: the FF-only + `--force-with-lease` constraints mean the script either
succeeds cleanly or fails without destroying unpublished work. If it fails
mid-flight, `main` may be checked out locally — return to `dev` with
`git checkout dev` and investigate before retrying.

---

## Why does dev's `package.json` only bump after the release?

`npm version patch` runs on `main` (that's where the release tag lives). It
creates a commit on `main` that bumps `package.json` from e.g. `1.6.5` → `1.6.6`
and tags it `v1.6.6`. At that moment, `dev` still shows `1.6.5` — no commit on
`dev` has yet bumped the version.

The `promote` script's final step is:

```bash
git checkout dev
git merge --ff-only main
git push origin dev
```

This fast-forwards `dev` to the same commit as `main`, so `dev`'s
`package.json` now also shows `1.6.6`. If you run the release manually (see
below) instead of via `npm run promote`, **don't forget this step** — otherwise
`dev` sits one commit behind `main`, and the next `npm run promote` will fail
its `main..dev` non-empty check (because `dev` has zero commits beyond `main`).

Recovery if you already forgot:

```bash
git checkout dev
git pull origin main
git push origin dev
```

---

## Manual / fallback flow (when `promote` breaks)

If `scripts/promote.mjs` fails partway through, or you need to cut a release
without running it, here is the full sequence. **Every command matters** —
skipping the last merge-back-to-dev is the most common mistake.

```bash
git checkout main && git pull --ff-only origin main
git merge --ff-only dev
npm version patch           # bumps package.json + server.json, commits, tags, pushes
git checkout dev
git merge --ff-only main    # <— EASY TO FORGET. Without this, dev's package.json stays at the old version.
git push origin dev
```

Notes:

- Replace `patch` with `minor` or `major` as needed.
- The `npm version` step fires the `version` hook (syncs `server.json`) and
  the `postversion` hook (`git push --follow-tags`), so the commit + tag on
  `main` are pushed to origin automatically. You do not need a separate
  `git push origin main` before the `dev` merge-back.
- If `git merge --ff-only dev` fails at step 2, `main` has diverged from
  `dev` — investigate before creating the tag.
- If `git merge --ff-only main` fails at step 5, `dev` has commits that
  aren't on `main` but the version commit landed on `main` anyway. Rebase
  `dev` onto `main` (`git rebase main`), then push.

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
- Force-push is **intentionally allowed**. The cherry-pick branch of
  `promote` rebases dev onto main and force-pushes with `--force-with-lease`.
  Blocking force-push here would break that flow.

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
