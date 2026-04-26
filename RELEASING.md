# RELEASING

Local reference for cutting releases of obsidian-brain. Not part of the docs site.

---

## Before you promote

### Preflight runs automatically

`npm run promote` runs `npm run preflight` first and aborts on any red. Run it manually only for a fast readiness check.

```bash
npm run preflight       # read-only, mirrors CI
npm run preflight:fix   # writes gen-docs / gen-tools-docs / gen-readme-recent first, then preflight
```

Use `preflight:fix` after editing `docs/CHANGELOG.md` (or any source the generators read). It's dev-convenience only — CI and `promote.mjs` both still call read-only `preflight`. If `preflight:fix` mutates files, commit them before `npm run promote` (its clean-tree assertion catches it on purpose).

Preflight steps (in order):

1. `gen-docs --check`
2. `gen-tools-docs --check`
3. `gen-readme-recent --check`
4. `check-plugin`
5. `check-env-vars`
6. `build` (tsc)
7. `test:coverage`
8. `test:python` (stdlib unittest for `scripts/build-seed.py`; needs `python3` on PATH)
9. `smoke`
10. `docs:build --strict`
11. `codespell` — best-effort; warns + skips if binary missing (`pip install codespell`)

Streams output live, prints a pass/fail summary with timings + a git-state footer, exits 1 on any required failure.

If green, skip to [How to release — one command](#how-to-release--one-command).

### What preflight does not cover (manual)

1. **CHANGELOG entry** at the top of `docs/CHANGELOG.md`. Format must match `## vX.Y.Z — YYYY-MM-DD — <title>` exactly — the `release.yml` `awk` extractor keys off this. See [CHANGELOG conventions](#changelog-conventions).
2. **Prune `docs/roadmap.md`'s "Planned / In progress"** if listed items are now shipping. "Recently shipped" auto-populates from CHANGELOG — don't touch it.
3. **If you touched a CLI subcommand or flag, update `docs/cli.md`.** `test/cli/help-snapshot.test.ts` snapshots `--help` as a forcing function. Regenerate with `vitest -u test/cli/help-snapshot.test.ts`; review the diff.
4. **No self-version refs in docs prose** (everywhere except `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/migration-aaronsb.md`) **AND in user-facing source strings** (tool descriptions in `src/tools/*.ts`, stderr writes, CLI help, error messages, bootstrap reasons in `src/pipeline/bootstrap.ts`). Phrases like "since v1.4.0" rot the moment a feature ships further back than the string remembers. Describe behaviour in present tense. **External dependency contracts** (`plugin v0.2.0+`, `Obsidian ≥ 1.10.0`, `Node ≥ 20`) **stay** — that's the user contract.

   Bootstrap reason strings: plain English. "embedding model changed", not "embedder identity hash changed". Technical detail belongs in code comments.

   Two gates catch it (both run by preflight):

   ```bash
   # Docs grep (manual sanity-check; same logic as the test below):
   grep -rnE "(since|in|as of|added in) v[0-9]+\\.[0-9]+(\\.[0-9]+)?\\b" docs/ \
     | grep -v "CHANGELOG.md\\|roadmap.md\\|migration-aaronsb.md\\|plugin v\\|plugin ≥"

   # CI-blocking test (scans src/**/*.ts string literals for vX.Y(.Z) outside
   # hyphenated identifiers like bge-small-en-v1.5):
   npx vitest run test/docs/no-version-refs.test.ts
   ```

   Allowlist for the test (`SRC_ALLOWLIST`) — extend rather than carving exceptions in source.

5. **New env-var read?** Declare it in `server.json packages[0].environmentVariables[]` AND keep `scripts/check-env-vars.mjs` ALLOWLIST in sync. `gen-docs` regenerates `docs/configuration.md` from `server.json`. Vars NOT part of obsidian-brain's public API (HF conventions like `HF_HOME`, XDG/platform conventions like `APPDATA`, legacy aliases) go on the ALLOWLIST with a one-line comment. `npm run check-env-vars` (in preflight + CI) catches drift either way.

### Stacking releases on dev

Works because `gen-readme-recent.mjs` is tag-aware: it includes only versions with a `vX.Y.Z` git tag OR the in-flight version in `package.json`. Release commits on dev no longer touch README — only CHANGELOG. The README block updates during `npm version`'s `version` lifecycle hook (inside `promote.mjs`), so each version-bump commit on main carries its own fresh block. Merge-backs are plain fast-forwards.

**Stack as many release commits on dev as you want.** Promote each with its own SHA target. No merge-back conflicts.

---

## What `npm version patch|minor|major` does

1. Bumps `package.json` version.
2. Fires the `version` lifecycle hook (`scripts/sync-server-version.mjs`) — rewrites every `"version"` field in `server.json` via regex (preserves inline formatting), then `git add server.json`.
3. Creates commit `chore: vX.Y.Z` containing `package.json` + `server.json`.
4. Creates annotated tag `vX.Y.Z`.
5. Fires the `postversion` hook: `git push --follow-tags` — pushes commit + tag in one call, triggering `release.yml`.

```json
"version":     "node scripts/sync-server-version.mjs && git add server.json",
"postversion": "git push --follow-tags"
```

**Never run `npm version` directly on `dev`.** `release.yml` has a main-branch guard that refuses to publish tags whose commit isn't on `main`.

---

## How to release — one command

```bash
npm run promote -- <commit>                  # patch bump
npm run promote -- minor <commit>            # minor
npm run promote -- major <commit>            # major

npm run promote -- --dry-run <commit>        # preview, no push
npm run promote -- --skip-preflight <commit> # rare — GHA outage etc.
```

`<commit>` is required. `npm run promote` with no SHA exits 1 — the script refuses to default to dev HEAD so you can't accidentally ship everything. To ship all of dev, find HEAD explicitly:

```bash
git log dev --oneline -1
npm run promote -- <that-sha>
```

`<commit>` accepts any ref git understands (short SHA, full SHA, tag). Must be on dev's first-parent trunk and newer than the last shipped commit. Args are order-independent (`npm run promote -- abc1234 minor` works); leading dashes on bump types are optional (`--patch` / `--minor` / `--major`).

### Dry run & preflight bypass

- `--dry-run` runs assertions, preflight, target resolution, pending-commit computation; exits before touching main or tagging.
- `--skip-preflight` skips the preflight gate. Don't use casually — preflight is what catches CI-failing code before a tag is pushed. Legitimate uses: a known-flaky docs-build dep during a GitHub Pages outage, or a hotfix where you've manually validated the subset that matters.

### What bump type to pick

`promote` never auto-detects:

- **patch** — bug fixes, docs, internal refactors; nothing that changes tool names, arg shapes, or observable behaviour.
- **minor** — new tools, new optional arg on an existing tool, new env var, any backwards-compatible feature addition.
- **major** — tool renamed or removed, required arg added, env var made required, anything forcing config or prompt updates.

When in doubt, patch. Under-bumping → consumers on `@latest` silently get the update. Over-bumping → permanent noise in version history.

### What commit hash to pass

```bash
# Easiest preview from any target:
npm run promote -- --dry-run <target-sha>

# Or list unshipped commits directly (last shipped SHA from latest tag's
# cherry-pick trailer; first-parent trunk since then):
LAST_TAG=$(git tag -l 'v*' --sort=-version:refname | head -1)
LAST_SHIPPED=$(git log -1 --format=%B "$(git rev-parse "$LAST_TAG^1")" | grep -oE 'cherry picked from commit [0-9a-f]+' | awk '{print $5}')
git log --first-parent --no-merges "$LAST_SHIPPED"..dev --oneline
```

Typical cases:

- Ship everything on dev → dev HEAD's SHA.
- Hold back a half-finished feature → SHA of the last stable commit before it.
- Broken commit on top of good work → SHA before the broken commit.

### What `promote` actually does

1. Parses args (bump + `<commit>` + flags).
2. Asserts current branch is `dev`.
3. Asserts a clean working tree.
4. `git fetch origin`.
5. Runs `npm run preflight` (unless `--skip-preflight`). If anything red, aborts.
6. Resolves the target commit; asserts it's reachable from dev.
7. Computes pending commits deterministically:
   - Latest `vX.Y.Z` tag (semver-sorted desc).
   - That tag's first parent is the last cherry-pick of that release. With `git cherry-pick -x` (used in step 10), every cherry-pick has a `(cherry picked from commit ORIGINAL_SHA)` trailer.
   - `base` = ORIGINAL_SHA from that trailer (the dev SHA last shipped).
   - Falls back to `git merge-base origin/main <target>` only on the very first promote (no version tags) or if the trailer is missing.
   - `pending = git log --first-parent --no-merges --reverse base..<target>`.

   Relies only on immutable git tags + cherry-pick `-x` trailers (canonical pattern; see `git-cherry-pick(1)`). No persistent state ref.
8. If `--dry-run`, exits after printing the pending list.
9. Switches to `main`, `git pull --ff-only`.
10. `git cherry-pick -x <sha>` for each pending commit. On conflict: exits 1, main left in conflicted state. Resolve or abort.
11. `npm version ${bump}` on main — fires `version` + `postversion` hooks (syncs `server.json`, creates commit + tag, pushes main + tag). Triggers `release.yml`.
12. Merge-back: checkout dev, `git fetch origin main`, `git merge --no-ff origin/main -m "chore: merge vX.Y.Z into dev"`. Plain push to origin/dev — **no force-push**.
13. Idempotent cleanup of any legacy `dev-shipped` ref. No-op once gone.
14. Prints summary.

### Force-push accounting

**Zero force-pushes in the normal promote flow.**

- **Main branch** — plain FF push (cherry-picks + bump). Cannot be force-pushed even by admin (`obsidian-brain/main` ruleset: `non_fast_forward` + `deletion`, no bypass).
- **Release tags** — new-ref push only. Immutable.
- **Dev branch** — plain FF push (merge-back appended).

The only situations needing a force-push are pure recovery (rewinding a borked main hotfix, surgical history rewrite). Those are explicit interventions, not part of `promote.mjs`.

Trade-off: dev's history becomes a DAG with one merge commit per release. Main stays strictly linear (enforced by `required_linear_history`).

---

## Manual / fallback flow (when `promote` breaks)

```bash
# 1. Preflight
npm run preflight

# 2. Find pending (deterministic — first-parent walk from last shipped SHA,
#    extracted from the latest tag's cherry-pick trailer):
git fetch origin
LAST_TAG=$(git tag -l 'v*' --sort=-version:refname | head -1)
LAST_SHIPPED=$(git log -1 --format=%B "$(git rev-parse $LAST_TAG^1)" | grep -oE 'cherry picked from commit [0-9a-f]+' | awk '{print $5}')
git log --first-parent --no-merges --reverse "$LAST_SHIPPED"..<target>

# 3. Put main at origin/main
git checkout main && git pull --ff-only origin main

# 4. Cherry-pick oldest-first
git cherry-pick -x <sha1> <sha2> ...

# 5. Bump + tag + push (fires version + postversion)
npm version patch                      # or minor / major

# 6. Merge-back to dev (NON-FF — creates a merge commit)
git checkout dev
git fetch origin main
git merge --no-ff origin/main -m "chore: merge v<new-ver> into dev"
git push origin dev                    # plain push, no force
```

- Cherry-pick conflict: resolve + `git cherry-pick --continue`. Messy: `git reset --hard origin/main` and start over.
- Merge-back conflict (step 6): resolve + `git add` + `git commit`. Standard GitFlow expects this occasionally.

---

## What happens after the tag

`.github/workflows/release.yml` fires automatically. Step order:

1. Checkout (full history — needed for the main-ancestor check).
2. Refuse to publish tags not on main (push only).
3. Wait for CI to succeed on this SHA (push only).
4. Resolve version (from tag name or `workflow_dispatch` input).
5. Setup Node.
6. Sync versions in `package.json` + `server.json` from tag.
7. Install dependencies (`npm ci`).
8. Build (`tsc → dist/`).
9. Setup Python (for MTEB metadata extraction).
10. Restore MTEB venv (cache hit fast-path).
11. Create venv + install mteb (cache miss only).
12. Regenerate model seed JSON (`data/seed-models.json` from MTEB's Python registry).
13. Validate seed JSON parses.
14. Install mcp-publisher.
15. **Validate `server.json`** — pre-publish gate.
16. Publish to npm (OIDC, with provenance).
17. Login to MCP Registry (OIDC).
18. Publish to MCP Registry.
19. Create / refresh GitHub Release (mark as latest).

`ci.yml` runs the full validation suite (tests + coverage, smoke, docs:build, gen-docs drift, codespell, plugin version check) on the same commit in parallel. `release.yml` deliberately does **not** re-run any of that — step 3's CI gate is the authoritative proof.

### Main-branch guard

Step 2 fetches `origin/main` and runs `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. Tagged commit not on `main` → exit 1, no publish.

### Wait for CI to succeed on this SHA

Polls `gh run list --workflow CI --commit $GITHUB_SHA` every 10s, up to 60 iterations (10 min). Early-exits on success (continue) or any non-success conclusion (refuse). No CI run within 10 min → refuse. Skipped for `workflow_dispatch` (manual override).

### Version sync from tag

`jq` rewrites `package.json.version` and both `server.json.version` and `server.json.packages[0].version` from the tag name. Defence-in-depth: under normal flow this is a no-op (`npm version` already set them). Last-chance correction if files drifted.

### MTEB seed regeneration (steps 9–13)

Every release rebuilds `data/seed-models.json` from MTEB's Python registry, so the bundled seed is always fresh. The MTEB venv is cached on `runner.os + arch + python-version + hash(scripts/requirements-build-seed.txt)`. Bumping `requirements-build-seed.txt` invalidates the cache and adds ~60s to the next release; otherwise step 11 is a no-op and the venv restore is fast.

### Validate `server.json` (PRE-publish)

`./mcp-publisher validate` runs before any publish happens. If `server.json` fails the MCP Registry schema (e.g. drift in the hand-maintained `environmentVariables[]` list), the workflow exits 1 — **nothing ships**: no npm tarball, no MCP Registry entry, no GitHub Release. Validation runs **before** `npm publish` so a malformed manifest can't leak an un-publishable-to-MCP tarball onto npm.

### npm publish

```
npm publish --access public
```

OIDC auth — no `NPM_TOKEN` secret. Trusted publisher configured once under the npmjs.com package settings (org `sweir1`, repo `obsidian-brain`, workflow `release.yml`). Publishes under the `latest` dist-tag.

### MCP Registry publish

`./mcp-publisher login github-oidc` then `./mcp-publisher publish`. Manifest already validated pre-publish.

### GitHub Release

Release notes extracted from `docs/CHANGELOG.md` with `awk`:

```awk
/^## v/ {
  inside = ($0 ~ "^## v" ver "( |$|—)")
}
inside
```

CHANGELOG header **must** be `## vX.Y.Z — YYYY-MM-DD — Title` (em dash `—`, U+2014). Wrong dash, extra spaces, or wrong capitalisation → no release notes (generic fallback). See [CHANGELOG conventions](#changelog-conventions).

---

## Plugin version-matching

Companion plugin lives at `../obsidian-brain-plugin/` (sibling repo, not on npm). Rule: **major.minor must match** (server `1.6.3` + plugin `1.6.1` is fine; server `1.7.0` + plugin `1.6.x` is not).

Bump locations in the plugin repo:

- `manifest.json` — `"version"` field (Obsidian reads this at install time)
- `versions.json` — new key for the new version with the minimum Obsidian API version it requires

`npm run check-plugin` reads both manifests, compares major.minor, exits 1 with a clear message on mismatch. Exits 0 with a warning if the plugin directory doesn't exist (normal in CI where only the server is checked out).

---

## Test coverage gate

Every release must pass the V8-provider per-file thresholds in `vitest.config.ts`. Three checkpoints:

1. **Preflight** (auto-invoked by promote) — `npm run test:coverage`.
2. **CI** — same on every push to `main` / `dev`. Required status check; non-admin PRs blocked on red.
3. **Release gate** — `release.yml` waits for CI green on the exact tagged SHA before `npm publish`.

📖 **Read [`docs/coverage.md`](./docs/coverage.md) before your first release.** It's the contract: gate shape, thresholds and why they're the floor, branch-vs-line gap, `/* v8 ignore */` policy, fast-check pilot, grandfather mechanism, the two discipline principles (forward + backward), manual ratchet, escape hatch.

Skipping `docs/coverage.md` is the fastest way to make this gate useless.

---

## Env-var hand-edit

`server.json.packages[0].environmentVariables[]` is **hand-maintained** — source of truth for the MCP Registry's published manifest and for `docs/configuration.md` (regenerated by `npm run gen-docs`).

Adding a new env-var:

1. Add the read in source (`src/config.ts` or wherever the variable is consumed).
2. Add the entry to `server.json` under `packages[0].environmentVariables[]`.
3. `npm run gen-docs` to regenerate `docs/configuration.md`.

`npm run check-env-vars` walks every `process.env.X` / `env.X` read in `src/` and asserts each appears in `server.json` (or on the `ALLOWLIST` in `scripts/check-env-vars.mjs` for HF/XDG conventions, legacy aliases, test-only flags). Drift fails preflight + CI.

---

## Rollback

### Tag not yet picked up by CI

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

Fix on dev → re-run `npm run promote -- <target-sha>`.

### CI fired but npm publish failed

Same: delete the tag. Package was never published, no npm action needed. Re-run promote when fixed.

### npm package already published

You can't unpublish (npm policy: blocked after 72h, and even within 72h breaks downstream caches). Instead:

```bash
npm deprecate obsidian-brain@vX.Y.Z "reason for deprecation"
```

Release a follow-up patch via `npm run promote -- <new-target-sha>`. Consumers on `@latest` auto-upgrade. The MCP Registry `latest` overwrites on the next release too.

### Merge-back conflict left dev in a weird state

`git merge --abort` resets dev to pre-merge. Don't reset main — it already shipped. Retry the merge-back manually:

```bash
git checkout dev
git fetch origin main
git merge --no-ff origin/main -m "chore: merge vX.Y.Z into dev"
# resolve conflicts, git add, git commit
git push origin dev
```

---

## Branch protection

Server-enforced via GitHub rulesets. Re-apply with `npm run setup:protection` (idempotent — updates by name).

Two rulesets on `main` + one on `dev`. The split exists because GitHub bypass actors operate per-ruleset, not per-rule: anyone who can bypass a ruleset bypasses every rule inside it. Admin needs to bypass the CI check (so `promote` can push bump commits) but NOT bypass force-push protection — hence two rulesets.

### `main` (hard rules) — `obsidian-brain/main`

Nobody bypasses, not even admin.

- Force-push blocked (`non_fast_forward`). `git push --force` and `--force-with-lease` both fail server-side.
- Deletion blocked (`deletion`). `git push origin :main` fails.

### `main` (workflow rules) — `obsidian-brain/main-workflow`

Admin can bypass (`bypass_mode: always`). Non-admins can't.

- Linear history required (`required_linear_history`). No merge commits on main. `promote`'s cherry-picks + `npm version`'s bump commit both satisfy this naturally.
- CI must pass (`required_status_checks` on context `Build, test, smoke, docs`). Any PR to main needs green CI. Dependabot is the primary beneficiary.

Why admin bypass here: `promote` pushes the bump commit + tag directly to main. That push hasn't been through CI at push time — CI fires on the push, concurrent with `release.yml`. Without bypass, `required_status_checks` would block the push itself. The publish gate lives in `release.yml`'s "Wait for CI" step instead, which protects npm publish regardless of push path.

### `dev` — `obsidian-brain/dev`

- Deletion blocked.
- Force-push **allowed**. Routine `promote` flow never force-pushes dev (merge-back is a plain push); allowed as the escape hatch for one-off history surgery (e.g. reordering unpushed commits).

---

## CHANGELOG conventions

```markdown
## vX.Y.Z — YYYY-MM-DD — Title

- Bullet describing user-visible change.
- Another bullet.
```

Rules:

- One entry per release. No "unreleased" section.
- Header on its own line, no trailing content after the title.
- Separator is em dash `—` (U+2014) with surrounding spaces — not hyphen-minus `-`, not en dash `–`. The `awk` extractor matches `( |$|—)` after the version; wrong dash → no release notes on GitHub.
- Bullets, not prose paragraphs. Short, user-facing, past-tense.
- Newest at top.
- **No real names anywhere in committed artifacts** — CHANGELOG, commit messages, code comments, docs. Describe bugs by symptom and scenario, not reporter. Made-up personas ("a user with a mixed-language vault") are fine; actual names aren't. Commit messages travel with the repo and are equally public.

The `awk` extractor reads from `^## v${VERSION}` (followed by space, EOL, or em dash) up to the next `## v` line or EOF. Everything between becomes the GitHub Release body verbatim.
