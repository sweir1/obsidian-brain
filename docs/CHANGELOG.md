---
title: Changelog
description: User-facing release notes. For full commit detail, see GitHub Releases.
---

# Changelog

User-facing release notes. For full commit-level detail see [GitHub Releases](https://github.com/sweir1/obsidian-brain/releases).

## v1.6.17 — 2026-04-24 — chore: bump typescript 5.9 → 6.0

**No user-visible change.** Dependency-update release. Upgrading from v1.6.16 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`typescript` 5.9.3 → 6.0.3** (the "prepare for TS7 Go port" release). Zero source edits and zero `tsconfig.json` edits required — our config already sidesteps every 6.0 deprecation (`moduleResolution: "nodenext"` not `node|classic`, `target: "ES2022"` not `ES5`, no `baseUrl`, no `outFile`, no `module: amd|umd|system`). Build, tests, coverage, smoke, strict docs build all green under 6.0.3 on first try.
- `ignoreDeprecations: "6.0"` intentionally *not* added — nothing in our tree triggers a deprecation, so the flag would silence warnings we don't have. Add it if/when transitive `@types/*` start warning in a later bump.

## v1.6.16 — 2026-04-24 — chore: bump chokidar 4 → 5, node floor 20.19

**No user-visible change.** Dependency-update release. Upgrading from v1.6.15 requires **Node.js ≥ 20.19.0**; drop-in otherwise.

- **`chokidar` 4.0.3 → 5.0.0.** One `watch()` call in `src/pipeline/watcher.ts` (function-based `ignored` matcher, four handlers for `add`/`change`/`unlink`/`error`). No source changes required — our matcher was already function-based (regex), which is what chokidar 5 wants. Internals are ESM-only now; package size dropped ~150kb → ~80kb.
- **`engines.node` bumped `>=20` → `>=20.19.0`.** Chokidar 5 requires Node 20.19+ (the first 20.x that can `require()` ESM synchronously). If you're running the MCP server under an older Node, bump it — `nvm install 20.19` or later. CI and release workflows were already on Node 24, so no workflow changes.

## v1.6.15 — 2026-04-24 — chore: bump diff 8 → 9

**No user-visible change.** Dependency-update release. Upgrading from v1.6.14 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`diff` 8.0.4 → 9.0.0.** Our usage is limited to `createPatch()` string output in `src/tools/edit-note.ts` (two call sites, dry-run diff summaries for bulk + single edits). v9's API-surface changes — ES5 support dropped, `merge()` removed, stricter `parsePatch` (mismatched header counts + `---`/`+++`-only patches now rejected), `StructuredPatch.oldFileName`/`newFileName` typed `string | undefined`, UMD global renamed `JsDiff` → `Diff` — don't affect us. No source edits required.
- **Types ship in-package in v9.** `@types/diff` was never in our `devDependencies`; no co-change needed.

## v1.6.14 — 2026-04-24 — Test rigor + branch coverage lift

**No user-visible change.** Test-suite-only release. Upgrading from v1.6.13 is drop-in — no schema migration, no config change, no runtime behaviour shift.

Follow-up to v1.6.13's coverage-gate setup: the gate was green but the underlying branch coverage sat at 76.95%, 13pp behind lines (90.42%). This release investigates why, fixes what's worth fixing, and documents what isn't. Final numbers: statements 91.6 (+2.4pp), branches 81.8 (+4.9pp), functions 90.6 (+1.8pp), lines 92.6 (+2.1pp). All 537 tests green.

- **Why branches trails lines — and why 85% is the realistic ceiling.** Every `if`/ternary/`??`/`?.`/`||`/`&&`/default-param is a countable branch; a single line like `const x = user?.profile?.name ?? 'anon'` produces 5 branches per 1 line. Happy-path tests give 100% lines and ~40% branches on that line. A 10–20pp gap is textbook for idiomatic TypeScript ([Codecov](https://about.codecov.io/blog/line-or-branch-coverage-which-type-is-right-for-you/)). 61% of the pre-v1.6.14 gap was defensive/unreachable code (`catch` arms, `instanceof Error` else-arms, ABI-heal messaging). Chasing those with contrived tests is coverage theatre.
- **V8 provider is accurate under Vitest 4** — not inflated. Since Vitest 3.2 the coverage-v8 provider ships `ast-v8-to-istanbul` AST remapping ([Vitest 3.2 blog](https://vitest.dev/blog/vitest-3-2.html)). Vitest 4 removed the old heuristic path entirely and makes AST the only mode ([Vitest 4 migration](https://vitest.dev/guide/migration.html)). Our 81.8% branches is a real number; switching to Istanbul would return the same number at ~3× the runtime.
- **22 rigor tests added** across replace-window (UTF-8 multibyte + regex-metachar literal match), fts5-escape (non-ASCII phrase-quoting + round-trip through a real FTS5 MATCH), patch-frontmatter (YAML array/object round-trip, overwrite, insert-into-fm-less, clear non-existent), parser (unclosed-frontmatter graceful fallback + console.warn signal), centrality (betweenness + PageRank ordering on star/chain topologies — the existing shape-only asserts would pass on a randomised algorithm). All 22 passed on first run, so existing code is correct; the tests now serve as regression guards against two plausible future bugs (`Buffer.byteLength` vs `.length` confusion, `\w` regex "fix" that breaks non-ASCII handling).
- **20 coverage-gap tests added**: new `test/tools/list-notes.test.ts` (no prior test existed), themeId paths on `rank-notes` (previously untested), nomic/mxbai/arctic-embed document-arm + mixedbread `||` short-circuit on `embedder-prefix`, `preserveCodeBlocks: false` + `preserveLatexBlocks: false` + sentence-split path on `chunker`, backward-edge `firstEdgeContext` on `pathfinding`. ~+3.8pp branches / ~+2pp lines.
- **`errorMessage` helper + single `/* v8 ignore next */`** — nine catch-sites across `edit-note`/`register`/`editor`/`context`/`obsidian/client` each reimplemented `err instanceof Error ? err.message : String(err)`. Centralised into `src/util/errors.ts :: errorMessage(err)` with one coverage-ignore on the `String(err)` fallback; the else arm was always unreachable noise (no call site throws non-`Error` values). Net: -18 unreachable branch arms, single rationale in one place. Grandfathered `watcher.ts` still has three inline sites — deliberately left alone to keep this commit scoped to coverage-measured files.
- **fast-check property-pilot for the chunker.** New `test/embeddings/chunker.properties.test.ts` runs three invariants over 500 total random markdown documents: chunkIndex contiguity, no raw protect-sentinel leakage, fenced code blocks appear intact in exactly one chunk. <1s added to the test run. Scoped to chunker because the sentinel protect/restore cycle and hard-cut collision avoidance have failure modes example-based tests can't anticipate. Expansion candidates (deferred): `wiki-links` rewrite round-trip, `fts5-escape` MATCH-validity across arbitrary Unicode.
- **Thresholds unchanged at 57/37.** The per-file-minimum floor-setters (`src/context.ts` at 59.5 lines, `src/tools/link-notes.ts` at 40.0 branches) didn't shift meaningfully — the files we tested weren't those floor-setters. Global aspirational target of 85% branches / 92% lines documented in `RELEASING.md` (not enforced — aspirational lives in docs, floors live in config). Next manual ratchet when the floor-setters themselves get dedicated tests.
- **Out of scope (deferred):** Stryker mutation testing (setup cost on TS+ESM+NodeNext ~half-day; right tool for the gap at 90%+ lines, wrong release), Istanbul provider switch (rejected — Vitest 4 V8 is equally accurate and faster), Codecov integration (json-summary already in reporters; adopt when a contributor joins).

## v1.6.13 — 2026-04-23 — Vitest coverage gate + promote cherry-pick flow

**No user-visible change.** CI + test-infrastructure addition. Upgrading from v1.6.12 is drop-in — no schema migration, no config change, no runtime behaviour shift.

Adds V8-provider coverage measurement via `@vitest/coverage-v8`, enforced per-file on every PR and push to main/dev. The gate fires locally via `npm run preflight` (so `npm run promote` can't slip a coverage regression past CI into a tag) and in `.github/workflows/ci.yml` (so PRs can't merge with under-threshold code). Coverage HTML report is uploaded as a CI artifact on every run (success or failure), so threshold trips are actionable from the GitHub Actions UI without a local re-run.

- **Thresholds**: baseline-anchored (per-file-minimum on non-excluded files, minus 3pp for refactor tolerance). Lines 57, branches 37 at v1.6.13 baseline. `perFile: true` so a 0%-covered new file trips the gate regardless of the project average. No autoUpdate — manual ratchet via small PR when baseline shifts up meaningfully. See `RELEASING.md` → "Test coverage" for the discipline principles (forward: new tests must assert; backward: don't retrofit existing tests to raise numbers).
- **Provider choice — V8 over Istanbul**: ~10% runtime overhead vs 20–40%, source-map-clean with vite-node, accurate enough for this codebase's imperative control flow.
- **Grandfather mechanism — `coverage.exclude`, not per-path thresholds**. Discovered during implementation: in vitest 4, per-path threshold keys can only *raise* the bar on matched files — they don't exempt files from the global floor. Vitest source is explicit: "Global threshold is for all files, even if they are included by glob patterns" (see [vitest-dev/vitest#6165](https://github.com/vitest-dev/vitest/issues/6165)). `coverage.exclude` is the only mechanism that actually exempts a file. Seven files currently excluded with rationale + TODO comments in `vitest.config.ts`: `src/cli/index.ts` (untested legacy CLI), `src/server.ts` (subprocess blind spot — V8 coverage doesn't follow into child processes; validated by `server-stdin-shutdown.test.ts` instead), `src/pipeline/watcher.ts` (genuinely untested), the three plugin-dependent tools `active-note.ts`/`base-query.ts`/`dataview-query.ts`, and `src/tools/find-path-between.ts` (missing direct wrapper test).
- **New npm scripts**: `test:coverage` (runs inside `preflight` and CI), `test:coverage:watch`. Plain `test` and `test:watch` stay coverage-free for fast local TDD loops.
- **CI integration**: `.github/workflows/ci.yml` now runs `npm run test:coverage` in place of `npm test` (the plain step, not wrapped in a retry — corrupt-HF-cache recovery already lives upstream in `scripts/prefetch-test-models.mjs`). New "Upload coverage report" step uses `actions/upload-artifact@v4` with `if: always()` and 14-day retention so the HTML report is reachable from every CI run green or red. Step-level cross-reference comments point between `ci.yml` and `scripts/preflight.mjs` so the two invocation sites can't silently drift.
- **RELEASING.md** gains a full "Test coverage" section covering gate shape, the exclude-based grandfather mechanism (with the vitest 4 behaviour explained), two discipline principles, manual ratchet cue, and escape hatch (write the test → adjust global threshold → add exclude, in that order of preference).

`@vitest/coverage-v8` pinned at `~4.1.0` — ships in lockstep with vitest major.minor, so patch-pin forces deliberate review on any minor bump.

**Promote script: cherry-pick flow (no dev force-push).** `scripts/promote.mjs` previously rebased dev onto main and `git push --force-with-lease origin dev` when releasing a commit older than dev HEAD ("cherry-pick release"). The rebase rewrote every dev commit after the target, so planned multi-release sequences had to re-resolve SHAs between each promote. The new flow uses `git cherry-pick -x` to copy pending commits from dev onto main as new linear commits, leaving dev untouched. Pending commits are detected via `git cherry origin/main <target>` — patch-id equivalence auto-skips content shipped in earlier promotes, so subsequent cherry-pick releases Just Work with zero tracking ref. Net result: **dev SHAs are stable across any number of releases**.

- **Trade-off (deliberate)**: dev's `package.json`/`server.json` no longer auto-sync to main's latest release. Nothing reads dev's version at runtime; `release.yml`'s `jq` rewrite overrides from the tag at publish time. Manual one-liner to sync: `npm version <ver> --no-git-tag-version --allow-same-version && git commit -am "chore: sync dev" && git push origin dev`.
- **Preflight now mandatory + automatic**: `npm run promote` invokes `npm run preflight` as its first step and aborts before touching main if anything is red. Manual pre-check is no longer required. Bypass with `--skip-preflight` (rare — GHA outage, known-flaky dep).
- **Preflight extended to mirror `ci.yml`**: two new steps — `docs:build` (strict MkDocs build) and `codespell` (best-effort; warns + skips if binary is missing, `pip install codespell` to enable). Gap-closes preflight vs CI so a green local run is a strong signal for a green CI run.
- **New flags**: `--dry-run` (preview pending commits + preflight, no mutation) and `--skip-preflight` (bypass the gate). Order-independent with existing bump/target args.
- **Conflict handling**: cherry-pick conflicts on main exit 1 with a resolution hint, leaving main in the conflicted state. Run `git cherry-pick --continue` / `--abort` as needed, or `git reset --hard origin/main` to start over.
- **`RELEASING.md`** rewritten: "What `promote` actually does", "Dev `package.json` lags main's releases", "Manual / fallback flow" (updated to cherry-pick steps), and "Branch protection → `dev`" (force-push still allowed for one-off surgery, but no longer used by `promote`).

**Auto-sync workflow: dev's `package.json` stays current without manual steps.** New `.github/workflows/sync-dev-version.yml` fires on every `v*` tag push (same trigger as `release.yml`) and bumps dev's `package.json` + `server.json` + `package-lock.json` to match the tag. Each run produces a one-step bump commit whose diff is patch-id-equivalent to main's `npm version` bump, so `git cherry` in subsequent `promote` runs silently skips it — no duplicate cherry-picks on main, no cherry-pick landmines. Uses the default `GITHUB_TOKEN` (with `permissions: contents: write` scoped to this job), which by GitHub's design does NOT trigger additional workflow runs — so the sync commit on dev does not re-fire `ci.yml` (no infinite loops). If dev somehow ends up more than one patch step behind the tag (skip-ahead scenario), the workflow flags a `::warning::` in the run log and applies the sync anyway; in that case a future `git cherry` will mark the sync commit `+` (not patch-id-equivalent) and a later `promote` may conflict on it — manual catch-up via incremental bumps is the recovery.

## v1.6.12 — 2026-04-23 — Test-layout refactor

**No user-visible change.** Pure test-suite reorganisation + a new shared-helpers directory. Upgrading from v1.6.11 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- Split five oversized test files into focused siblings grouped by feature:
  - `test/integration/server-init-timing.test.ts` (753 lines, 18 tests) → 4 files under `test/integration/server-init-timing/` (search, list-notes, write-tools-immediate-response, write-tools-eventual-reindex)
  - `test/tools/move-note.test.ts` (589 lines, 13 tests) → 5 files under `test/tools/move-note/` (rewrite-inbound-links, stub-pruning, dry-run, ghost-link-fix, rename-node)
  - `test/vault/editor.test.ts` (427 lines, 32 tests) → 5 files under `test/vault/editor/` (position, replace-window, patch-heading, patch-frontmatter, bulk)
  - `test/obsidian/client.test.ts` (424 lines, 16 tests) → 3 files under `test/obsidian/client/` (discovery-auth, dataview, base)
  - `test/integration/graph-tools.test.ts` (419 lines, 7 tests) stays as one file but now imports shared helpers and uses a `cleanupCtx` helper for the fire-and-forget reindex-drain teardown
- New `test/helpers/` directory hosts repo-wide test utilities: `mock-server.ts` (MCP `makeMockServer` + `unwrap`), `mock-embedders.ts` (`InstantMockEmbedder` + `SlowMockEmbedder`), `init-timing-ctx.ts` (controllable init-state ServerContext), `reindex-spy.ts` (fire-and-forget spy + poll helper), `graph-ctx.ts` (simple real-embedder ctx + teardown)
- Full suite at 492/492 passing, zero type errors, preflight green, no source (`src/`) changes

## v1.6.11 — 2026-04-23 — Schema rename to `target_subpath` + explicit migration chain + auto-heal on Node-ABI mismatch

**No user action required.** Internal refactors + a new best-effort recovery path. Upgrading from v1.6.10 is drop-in: the migration chain handles schema v4 → v5 automatically on next boot, existing data survives the `ALTER TABLE RENAME COLUMN`, no reindex needed. Fresh installs get the new column name from day 1.

**Schema rename (internal).** `edges.target_fragment` → `edges.target_subpath`. Aligns the column with the Obsidian ecosystem's convention (Obsidian API `LinkCache.subpath`, Dataview `Link.subpath`, Juggl — all use `subpath`; we were the odd one out using `target_fragment`, a legitimate HTML/URL prior-art name but non-standard here). Zero public-API impact — the column isn't visible to agents or tool responses.

**Explicit migration chain.** Replaced the one-off "if schema_version != SCHEMA_VERSION" branch in `bootstrap()` with a proper `SCHEMA_MIGRATIONS` array keyed by target version. The runner walks the chain in order, bumping `schema_version` incrementally so a crash mid-chain is safe. A belt-and-braces unconditional pass at the end runs every migration helper (all PRAGMA-guarded idempotent) so DBs where `schema_version` got stamped ahead of the actual schema get healed automatically. This is the infrastructure for future schema changes — add a migration in two places (helper + array entry) and it plays forward correctly from any historical schema version.

**Auto-heal on Node-ABI mismatch (v1.6.10 static error → v1.6.11 best-effort rebuild).** When `better-sqlite3` fails to load because its compiled ABI doesn't match the current Node (typical after a Node upgrade leaves a stale cached binary in `~/.npm/_npx/`), the server now detects this, spawns a detached `npm rebuild better-sqlite3` in the background, logs the rebuild to `/tmp/obsidian-brain-rebuild-*.log`, and tells the user to restart in ~60 seconds. A per-ABI marker at `~/.cache/obsidian-brain/abi-heal-attempted-<ABI>` prevents infinite retry loops — if the rebuild itself keeps failing (typically a missing C++ toolchain), the second restart shows a "manual fix required" message pointing at the log. Windows falls back to the v1.6.10-style static error message (detached subprocess semantics differ).

- `src/pipeline/bootstrap.ts`: introduced explicit `SCHEMA_MIGRATIONS` array at module scope; bootstrap loops through it, bumping `schema_version` incrementally; belt-and-braces unconditional second pass at the end
- `src/store/db.ts`: `SCHEMA_VERSION = 5`, `CREATE TABLE edges` now uses `target_subpath`, `renameTargetFragmentToSubpath()` migration helper added (PRAGMA-guarded idempotent), `ensureEdgesTargetFragmentColumn()` extended to be a no-op on v5+ DBs
- `src/store/edges.ts`, `src/types.ts`, `src/vault/parser.ts`, `src/pipeline/indexer.ts`: rename `targetFragment` → `targetSubpath` in types + SQL + parser output
- `src/context.ts`: `tryAutoHealAbiMismatch` wraps `doAutoHeal` in an outer try/catch so any unexpected failure degrades cleanly to the v1.6.10 static message. Spawns plain `npm rebuild better-sqlite3` (dropped the `--update-binary` flag — that was a node-pre-gyp passthrough, `better-sqlite3` uses `prebuild-install` which doesn't recognize it). `rebuildCwd` fixed to point at project root instead of inside `node_modules`. Stale binary at `build/Release/better_sqlite3.node` is pre-deleted so `prebuild-install` always fetches a fresh correct-ABI tarball
- `package.json`: dropped the same `--update-binary` flag from the postinstall hook for the same reason
- `test/pipeline/bootstrap.test.ts`: new `v4 → v5` rename-migration test; existing `pre-v4` and belt-and-braces tests updated to `target_subpath`
- `test/pipeline/indexer.test.ts`, `test/tools/find-connections.test.ts`, `test/tools/read-note.test.ts`: rename references updated; pre-v5 state simulated by dropping `target_subpath` (since fresh `:memory:` now starts at v5)
- `test/context.test.ts`: auto-heal tests for the three paths (first attempt spawns rebuild, marker-exists path skips spawn, non-ABI errors pass through). `withEnv` helper made `async` so env vars stay set until the async test body resolves. `fs.unlinkSync` mocked so the "delete stale binary" step doesn't touch the real repo's `better_sqlite3.node`

## v1.6.10 — 2026-04-23 — Clean shutdown (no more libc++abi crashes) + Node-ABI mismatch defense

**⚠ Shutdown-crash fix.** On shutdown the server used to call `process.exit(0)` immediately after closing the chokidar watcher, leaving the ONNX Runtime thread pool (used by the default transformers.js embedder) mid-flight. V8 tore down the addon's heap while worker threads were blocked on `pthread_mutex_lock`, producing `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument` on stderr and an abnormal SIGABRT exit. Hosts (Claude Desktop, Jan) saw the server as unstable and could back off. No data loss — WAL mode is crash-safe — but noisy. Now shutdown explicitly awaits `embedder.dispose()`, closes the SQLite handle, then lets the event loop drain naturally (with a 4 s hard-exit fallback in case something refuses to release).

**Node-ABI mismatch — first-class error + passive defense.** If a cached `~/.npm/_npx/.../better-sqlite3.node` was compiled for a different Node major than the runtime, Node emits a raw `NODE_MODULE_VERSION X ... requires Y` error that names an opaque hash-keyed path and gives no remediation hint. The server now detects this at startup and rewrites the error to include the one-line fix (`rm -rf ~/.npm/_npx`). A `postinstall` hook (`npm rebuild better-sqlite3 --update-binary`) makes future `npx @latest` installs rebuild against the current Node automatically, closing the trap on Node upgrades.

- `src/server.ts` shutdown: explicit `await ctx.embedder.dispose()` (if ready) + `ctx.db.close()` + `process.exitCode = 0` instead of `process.exit(0)`, with a 4 s `.unref()` fallback timer
- `src/context.ts`: wrap `openDb()` in a try/catch that recognises `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED` and re-throws with remediation + link to docs
- `package.json`: `"postinstall": "npm rebuild better-sqlite3 --update-binary || true"` — rebuilds the native module against the current Node on every fresh install
- `docs/troubleshooting.md`: extended the `ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch` section with the npx-cache-poisoning scenario
- `test/integration/server-stdin-shutdown.test.ts`: new SIGTERM test asserts exit code 0 plus stderr contains no `libc++abi` / `mutex lock failed`
- `test/context.test.ts` *(new)*: mocks `openDb` to throw ABI and non-ABI errors; verifies the guard rewrites the first case, passes through the second

No data migration or reindex needed — upgrading from v1.6.9 is drop-in.

## v1.6.9 — 2026-04-23 — find_connections / read_note migration fix + Jan compatibility

**⚠ Data-integrity fix for upgraders.** Any database created before v1.6.5 was missing the `edges.target_fragment` column. v1.6.5 introduced the column in the `CREATE TABLE IF NOT EXISTS` body (so fresh installs were fine) and shipped an idempotent `ensureEdgesTargetFragmentColumn()` migration helper, but the call site inside `bootstrap()` was never wired up. Upgraders saw `Error: no such column: target_fragment` from `find_connections` and `read_note` (full mode) from v1.6.5 onward — even across rebuilds — because `bootstrap()` bumped `schema_version` to 4 without actually running the `ALTER TABLE`. `search`, `list_notes`, and `dataview_query` were unaffected because they don't touch the `edges` table. This release actually runs the migration.

**Jan compatibility.** v1.6.8 added `process.stdin` `end` / `close` → `process.exit(0)` handlers to stop zombie servers when the host crashed. Unfortunately Jan (jan.ai) briefly closes stdin during its local-LLM model load between the MCP `initialize` handshake and the first `tools/list`, which tripped those handlers and killed the server mid-boot — every subsequent tool call got `Transport closed`. Replaced with a cross-platform orphan watcher that probes the original parent PID once a minute via `process.kill(pid, 0)`, plus the MCP SDK's own `transport.onclose` for normal shutdowns. Ghost-process defense is preserved; Jan no longer trips it.

- `src/pipeline/bootstrap.ts`: call `ensureEdgesTargetFragmentColumn(db)` inside the schema-version-bump branch AND once unconditionally before return (belt-and-braces, matches how `ensureVecTables` is already called on every boot; the helper is PRAGMA-guarded so double-call is free)
- `src/server.ts`: removed `process.stdin.on('end'/'close')` → `process.exit(0)`. Added `transport.onclose` plus a `setInterval` (60 s, `.unref()`) that calls `process.kill(originalPpid, 0)` and shuts down on `ESRCH`. Cross-platform: macOS/Linux catch reparenting-to-PID-1; Windows catches the dead-parent-PID case. One syscall per minute — zero measurable cost
- `test/pipeline/bootstrap.test.ts`: two new regression tests — pre-v4 DB with `schema_version=3` triggers the bump-branch migration, and pre-v4 DB with `schema_version=4` already current triggers the unconditional heal path
- `test/tools/find-connections.test.ts` *(new)*: handler smoke against a pre-v4 DB — would have caught the original bug at PR time
- `test/tools/read-note.test.ts` *(new)*: handler smoke for both `brief` and `full` modes

Cleanup if you were stuck on v1.6.5–1.6.8 with a pre-v4 DB: nothing to do — next boot under v1.6.9 runs the `ALTER TABLE` automatically. Existing rows get `target_fragment = NULL` (valid — only heading / block wiki-links populate it). No reindex required.

## v1.6.8 — 2026-04-23 — Exit cleanly when MCP client disconnects (no more zombie processes)

**⚠ Zombie-process fix.** When an MCP client (Claude Desktop, Jan, Cursor, Codex, VS Code) crashed or was force-quit without cleanly shutting down the servers it spawned, `obsidian-brain server` kept running — reparented to launchd (macOS) or init (Linux) — until the user manually killed it. Across many client restarts / crashes, zombies accumulated indefinitely.

The stdio transport signals "parent gone" by closing the pipe (stdin EOF on the server side). Previously the server only listened for `SIGINT` and `SIGTERM`, which crashed clients don't send. Now `process.stdin` `end` and `close` events trigger the same graceful shutdown path, with a shutdown-reason logged to stderr so users watching logs understand why the process exited.

- `src/server.ts` + `src/cli/index.ts`: stdin `end` / `close` events call the shutdown handler (alongside the existing SIGINT / SIGTERM signals), with an idempotent `shuttingDown` guard so duplicate triggers don't double-fire
- Shutdown now logs its reason (`SIGINT` / `SIGTERM` / `stdin EOF (MCP client disconnected)` / `stdin closed (MCP client disconnected)`) to stderr
- New `test/integration/server-stdin-shutdown.test.ts` spawns the compiled CLI, closes stdin, and asserts the child exits within 3 s

To clean up any zombie `obsidian-brain server` processes from before this fix: `pkill -f 'obsidian-brain server'` (macOS/Linux).

## v1.6.7 — 2026-04-23 — MCP init timeout fix + non-blocking write tools

**⚠ Behavior change for write tools.** `create_note`, `edit_note`, `apply_edit_preview`, `move_note`, `delete_note`, and `link_notes` now return as soon as the write completes; the subsequent reindex runs in the background instead of being awaited inside the response. A newly-written note becomes searchable within a few seconds (same window as the file watcher has always had for out-of-band edits). Agents or scripts that implicitly relied on synchronous write-then-search must either await a small delay or explicitly call `reindex` before the follow-up search.

**Init timing fix.** The MCP `initialize` handshake no longer waits for the embedding-model download. Previously, on a fresh install with slow internet, the ~34 MB model download took longer than MCP clients' (Claude Desktop, Jan, Cursor) handshake timeout, leaving users locked out with a "tools failed" message. Now `server.connect(transport)` runs immediately; the model download + first-time index proceed in parallel. Tools that don't need the embedder (`list_notes`, `read_note`, `find_connections`, `find_path_between`, `rank_notes`, all write tools, fulltext search, plugin-dependent tools) respond instantly. Semantic search returns a structured `{status:'preparing', message:…}` response during the download window — within the client timeout — instead of hanging.

If the background init fails (e.g. model not found, network error), semantic search returns `{status:'failed', message:…}` with an actionable message; restart the MCP server to retry.

- Reordered `server.connect(transport)` to run before the embedder + first-time-index pipeline
- `search({mode:'semantic' | 'hybrid'})` returns `preparing` / `failed` status immediately when the embedder isn't ready
- Six write tools fire-and-forget their post-write reindex; the `reindex: 'failed'` envelope is removed from their return types
- `fulltext` search, all read tools, graph tools, and write tools are unblocked from first-run model download
- Embedder auto-recovers from a corrupt local Hugging Face cache: on a `Protobuf parsing failed` / `Load model failed` / `Unable to get model file` error on first load, the model's cache subdirectory is wiped and re-downloaded once automatically (previously required a manual `rm -rf` of the HF cache)
- 18 new integration tests in `test/integration/server-init-timing/` drive a slow-init mock embedder end-to-end; full suite at 479/479 passing with zero stderr noise from background reindexes

## v1.6.6 — 2026-04-23 — Docs + website overhaul + release automation

Server runtime behavior unchanged. Large docs, website, and maintenance-automation release.

### Docs + website

- **New non-technical macOS guide** (`docs/install-mac-nontechnical.md`) — front-to-back walkthrough covering Homebrew, Node 20+, the `/usr/local/bin` symlink that lets Claude Desktop and Jan see `node` (GUI apps inherit a minimal PATH that excludes `/opt/homebrew/bin`), Full Disk Access setup, and the first-boot model-download wait.
- **Four new troubleshooting sections**: GUI-app `ENOENT` on `node`/`npx`, macOS Full Disk Access silent failure (vault reads empty / HF model download hangs), stale `~/.npm/_npx` cache loading an old version, and corrupt transformers.js model cache.
- **Jan config shape corrected**: `docs/jan.md` and `docs/install-clients.md` now document the unwrapped `{ "obsidian-brain": {...} }` top-level shape Jan uses — different from Claude Desktop's `mcpServers`-wrapped shape.
- **Website simplification**: dropped the custom `home.html` hero + animated SVG, all four custom stylesheets (`theme.css`, `hero.css`, `features.css`, `overrides.css`), the IBM Plex Sans + Fraunces + JetBrains Mono font stack, and the vellum/violet/berry palette. Now runs on stock Material (primary `blue`, white background in light mode, `slate` scheme in dark) with zero custom CSS.
- **Proper landing page** (`docs/index.md`): plain markdown, install-in-60-seconds code snippet, 2×3 feature grid (Find / Map / Write / Private / Fast / No plugin), "Why not Local REST API?" differentiation section. Left nav + right TOC hidden on the landing via `hide: [navigation, toc]` frontmatter.
- **MkDocs strict-mode hardening**: `validation.links.anchors: warn` promotes previously-silent INFO-level link warnings to WARN, so `mkdocs build --strict` now fails on broken internal anchors. Fixed 3 pre-existing broken anchor links in `architecture.md` + `troubleshooting.md` that had been shipping since v1.5.x.
- **GitHub issue templates**: structured bug-report form capturing client, OS, Node version/path, log excerpt, config, and the three sanity-checks that catch most reported issues (`@latest` in config, cleared npx cache, Full Disk Access); lean feature-request form; `config.yml` disables blank issues and links to troubleshooting / install-clients / mac walkthrough.
- **README tweaks**: signpost to the mac walkthrough below the first-boot note, and a fourth troubleshooting bullet for the stale-npx-cache symptom.

### Release + maintenance automation

- **`RELEASING.md`** (repo root, 364 lines) — end-to-end release reference covering `npm version patch|minor|major` internals, the one-command `npm run promote` flow, what fires after the tag (OIDC npm + MCP Registry + GitHub Release), plugin same-major.minor rule, HF cache key bump, env-var hand-edit notes, rollback steps, pre-release checklist.
- **`npm run promote`** (`scripts/promote.mjs`) — one-command dev→main + version + tag + push. Guards: branch is `dev`, tree clean, `main..dev` non-empty, FF-only merges both ways. Auto-returns to `dev` and FF-merges `main` back so `dev`'s `package.json` stays current. Accepts optional `patch|minor|major` arg.
- **`.github/workflows/ci.yml`** — validation-only CI on every PR and every push to `main`/`dev`. Runs `npm ci`, `npm run build`, `npm test` (454 vitest tests), `npm run smoke` (17 MCP tools), `npm run docs:build --strict`, generator drift checks, plugin version check, codespell. Never publishes — publishing remains tag-only via `release.yml`.
- **`.github/pull_request_template.md`** — checklist: CHANGELOG entry, server.json env-vars sync, `.describe()` updates, plugin version impact, local smoke + docs checks, HF cache-key bump.
- **`.github/dependabot.yml`** — weekly grouped updates for npm, pip (website toolchain), and github-actions.
- **`release.yml` header** spells out the three separate guarantees that prevent dev from publishing: trigger filter (`tags: ["v*"]` only), tag origin (only promote creates v* tags on main), main-branch guard step (refuses tags not reachable from `origin/main`).

### Generated docs — single source of truth

- **`docs/configuration.md`** env-var table now auto-generated from `server.json.packages[0].environmentVariables[]`. Between `<!-- GENERATED:env-vars -->` markers. `npm run gen-docs` regenerates; `-- --check` for CI drift detection. Legacy aliases section and per-var narrative (for `EMBEDDING_MODEL` / `EMBEDDING_PRESET` / `EMBEDDING_PROVIDER`) preserved outside markers.
- **`docs/tools.md`** per-tool argument tables now auto-generated from Zod schemas via `npm run gen-tools-docs` (runs under `tsx`). 17 per-tool `<!-- GENERATED:tool:* -->` slots; narrative (descriptions, examples, "Since vX.Y" notes, Claude prompt hints, capability matrix) preserved byte-for-byte outside slots. `edit_note` slot is marked `manual` — its 15+ mode-dependent fields don't fit a flat table.
- **14 `src/tools/*.ts` files** got `.describe()` annotations on every Zod field that lacked them. Argument descriptions now live in the schema (source of truth) rather than duplicated in markdown. Runtime behavior unchanged — `.describe()` attaches metadata only.
- **`preversion` hook extended** — runs `gen-docs`, `gen-tools-docs`, `check-plugin` and stages the regenerated docs, so `npm version X` can't tag a release whose docs are out of sync with the schemas they describe.

### Roadmap — low-friction idea capture

- **`docs/roadmap.md` restructured** (97 → 65 lines): four sections — Recently shipped (`{{ recent_releases(5) }}` macro, auto-pulls from CHANGELOG at build time), Planned / In progress (hand-curated), Ideas (`<!-- IDEAS:start/end -->` markers for append-only firehose), Versioning policy.
- **`npm run idea -- "cross-vault search"`** (`scripts/idea.mjs`) appends a dated bullet between the Ideas markers. Zero friction.
- **`website/main.py`**: new `@env.macro recent_releases(n=5)` function parses CHANGELOG headers and returns a markdown bullet list. Surfaces every tagged release on the roadmap without manual maintenance.

### Plugin version-matching

- **`npm run check-plugin`** (`scripts/check-plugin-version.mjs`) — reads `./package.json` version and `../obsidian-brain-plugin/manifest.json` version, compares major.minor only. Exits 1 on mismatch, 0 with a warning if the sibling plugin dir isn't checked out (CI case), skipped if `SKIP_PLUGIN_CHECK=1`.

### Dev-loop ergonomics

- **`npm run docs`** — start the local MkDocs server on 127.0.0.1:8000 with hot reload.
- **`npm run docs:build`** — same strict build as CI, locally.
- **`.gitignore`** — ignore `__pycache__/` + `*.pyc` (needed now that the website build imports a local Python module).

## v1.6.5 — 2026-04-23 — Heading/anchor stub lifecycle (schema v4)

- `[[Target#Section]]` and `[[Target^block]]` now migrate the same way bare `[[Target]]` forward-references do. Previously they became `_stub/Target#Section.md` stubs that `resolveForwardStubs` explicitly skipped — so even after `Target.md` existed, the graph kept a dangling heading-anchor stub indefinitely.
- Schema bump 3 → 4: new `edges.target_fragment TEXT` column holds the `#heading` or `^block` suffix, while `target_id` stays bare. Idempotent `ALTER TABLE` migration runs on bootstrap; upgraders get a one-time reindex to clean up pre-v1.6.5 fragment-embedded stubs.
- Rename flows preserve fragments through `renameNode`: `target_id` updates, `target_fragment` rides alongside.

## v1.6.4 — 2026-04-23 — Path-qualified wiki-link rewriting

- `move_note` now rewrites path-qualified wiki-links like `[[notes/BMW]]` and `[[notes/BMW.md]]` alongside bare `[[BMW]]`. A cross-folder rename (e.g. `notes/BMW.md` → `cars/BMW & Audi.md`) now correctly updates all three reference shapes: bare stays bare, path-qualified gains the new full path, and `.md` suffix is normalised.
- The same-stem early-out is removed from `rewriteInboundLinks` / `previewInboundRewrites` — a pure cross-folder move with an unchanged basename still rewrites any path-qualified inbound references. Bare-stem references with an unchanged stem are left alone (they still resolve via Obsidian's stem lookup post-move).

## v1.6.3 — 2026-04-23 — `renameNode` primitive, inbound edges survive rename

- New `src/store/rename.ts` — one transactional helper (`renameNode`) that rewrites every row keyed on a node id in place: nodes, edges in/out, chunks (composite `${nodeId}::${chunkIndex}` ids + node_id), sync path, community membership JSON. Uses `PRAGMA defer_foreign_keys = ON` so chunks-to-nodes FK is checked at commit rather than mid-transaction.
- `move_note` rewired to use it: disk move → rewrite inbound source files → `renameNode` (DB atomic) → absorb any residual forward-reference stub via `migrateStubToReal`. Inbound edges now survive the rename intact; graph analytics membership and chunk embeddings are preserved (no re-embed on rename).
- Removes the delete-then-upsert pathway that previously dropped every inbound edge in `pipeline.index()`'s deletion-detection loop — the root mechanism behind the v1.6.2 ghost-link symptoms.

## v1.6.2 — 2026-04-23 — `move_note` ghost-link fix

- `move_note` now rewrites inbound wiki-links correctly when a source's edge targets a stub path (`_stub/<oldStem>.md`). Pre-v1.5.8 vaults and any note created via the watcher path before the target was indexed could carry stub-target edges indefinitely; the rewrite step silently skipped them, leaving ghost `[[oldName]]` links on disk and dangling graph edges. `rewriteInboundLinks` now merges both real-target and stub-target inbound edges.
- `indexSingleNote` (the watcher's per-file reindex path) now migrates forward-reference stubs the same way `create_note` does. A note added via Obsidian for a previously-forward-referenced stem will now repoint stub inbound edges to the new real node on the spot, instead of leaving them for a full vault reindex to clean up.
- After `rewriteInboundLinks` writes new content to source files, their sync mtime is zeroed so the subsequent reindex reparse cannot be suppressed by the `prevMtime >= mtime` skip-check on filesystems with 1-second mtime resolution.

## v1.6.1 — 2026-04-23 — Multilingual preset tightening

- `EMBEDDING_PRESET=multilingual` — framing flipped: transformers.js multilingual now positioned as the one-env-var config-only path. Works end-to-end (verified: 384-dim output, cross-lingual EN↔JA cosine 0.76).
- Corrected `presets.ts` size metadata: combined download is ~135 MB (118 MB ONNX + 17 MB tokenizer.json), not 118 MB.
- `docs/embeddings.md` multilingual section rewritten — Ollama-for-multilingual demoted to "Advanced" alternative.
- Auto-GitHub-Release step added to `release.yml` — every tag now auto-creates its Release page with notes from this changelog, marked `--latest`. (Back-filled v1.5.8 + v1.6.0 manually before this shipped.)
- Docs + README + website reorg: single-source-of-truth per fact. README 773 → 121 lines; new `docs/configuration.md`, `docs/embeddings.md`, `docs/migration-aaronsb.md`, `docs/development.md`, `docs/CHANGELOG.md`. MkDocs nav reshuffled.

## v1.6.0 — 2026-04-22 — Agentic-writes safety bundle

Paired plugin: **v1.6.0**. One new MCP tool; tool count 16 → 17.

- `dryRun: true` on `edit_note`, `move_note`, `delete_note`, `link_notes` — returns a preview without writing.
- New tool `apply_edit_preview(previewId)` — commits a preview returned by `edit_note({dryRun: true})`. File-drift guarded; 5-minute TTL.
- Bulk `edits: [...]` on `edit_note` — atomic chain; error names the failing index, nothing lands on disk.
- `fuzzyThreshold: 0–1` on `replace_window` (default 0.7).
- `from_buffer: true` on `edit_note` — retries a prior `replace_window` NoMatch with `fuzzy: true, fuzzyThreshold: 0.5`.
- New runtime dep: `diff@^8` for unified-diff generation.

## v1.5.8 — 2026-04-22 — Stub-lifecycle + FTS5 + hybrid-chunks

Paired plugin: v1.5.5 (patch drift acceptable).

- Stub-lifecycle fixes: `move_note` and `delete_note` no longer orphan stubs; forward-references (`[[X]]` before `X.md` exists) auto-upgrade when the real note is created.
- FTS5 crash on hyphenated queries fixed (e.g. `foo-bar-baz`) — conditional phrase-quoting in `src/store/fts5-escape.ts`.
- `search({mode: 'hybrid', unique: 'chunks'})` now returns chunk metadata (was semantic-only).
- `reindex({})` response includes `stubsPruned: N` — migration path for upgrading users with orphan stubs in their DB.

## v1.5.7 — 2026-04-22

- Advertised version now reads from `package.json` at runtime via `createRequire`. No more drift between tag and `server.version` in `initialize`.

## v1.5.2 — 2026-04-22 — Embedding presets

Paired plugin: v1.5.2.

- New `EMBEDDING_PRESET` env var: `english` / `fastest` / `balanced` / `multilingual`.
- Default model flipped to `Xenova/bge-small-en-v1.5` (was `all-MiniLM-L6-v2`). Auto-reindex on first boot.
- README restructured: honest ≤60 MB budget, multilingual via Ollama.

## v1.5.1 — 2026-04-22

- BGE/E5 asymmetric-model prefix fix — query-side prefix is now applied (was silently dropped).
- Stratified migration via `prefix_strategy_version` metadata; BGE/E5 users get a targeted reindex on upgrade.

## v1.5.0 — 2026-04-22 — Agent UX + Ollama

Paired plugin: v1.5.0.

- Ollama embedding provider (`EMBEDDING_PROVIDER=ollama`).
- `next_actions` response envelope on `search` / `read_note` / `find_connections` / `delete_note`: `{data, context: {next_actions}}`. Clients ignoring `context` keep working.
- `move_note` rewrites all inbound wiki-links across the vault (`linksRewritten: {files, occurrences}`).
- `edit_note({mode: 'patch_heading'})` throws `MultipleMatchesError` with per-occurrence line numbers when a heading is ambiguous; `headingIndex: N` disambiguates.
- `read_note({mode: 'full'})` returns `truncated: true` when the body exceeds `maxContentLength`.
- `includeStubs: false` on `detect_themes` + `rank_notes`.
- Graph analytics credibility guards: `rank_notes(pagerank)` defaults `minIncomingLinks: 2`; low-modularity Louvain clustering surfaces a `warning`; betweenness normalised 0–1.

## v1.4.0 — 2026-04-22 — Retrieval foundation + Bases

Paired plugin: v1.4.0.

- **Chunk-level embeddings**: each note is split at markdown headings (H1–H4), oversized sections further split on paragraph / sentence boundaries; code fences and `$$…$$` LaTeX blocks preserved. SHA-256 content-hash dedup means unchanged chunks don't re-embed.
- **Hybrid RRF search** is the default: `search({query})` fuses chunk-level semantic + FTS5 full-text ranks via Reciprocal Rank Fusion.
- Pluggable `Embedder` interface; `EMBEDDING_MODEL` env var with auto-reindex on change.
- Obsidian Bases integration via companion plugin + new `base_query` tool (Path B — own YAML + expression evaluator).
- FTS5 polish: porter stemming + column-weighted BM25 (5× title vs body).

## v1.3.0 — v1.3.1 — Dataview

Paired plugin: v0.2.0 → v0.2.1.

- `dataview_query` MCP tool via companion plugin. Returns discriminated union: `table` / `list` / `task` / `calendar`.
- 30s default timeout (Dataview has no cancellation API).

## v1.2.0 — v1.2.2 — Companion plugin foundations

Paired plugin: v0.1.0.

- `active_note` tool (first plugin-dependent tool).
- Defensive hardening: per-tool timeout, SQLite WAL `busy_timeout = 5000`, embedder request serialisation.
- Theme-cache correctness; `patch_heading` `scope: 'body'`; `valueJson` for stringifying harnesses.

## v1.0.0 — v1.1.x — Foundations

- Core semantic search + knowledge graph + vault editing over stdio MCP (v1.0.0).
- Live file watcher (chokidar) + offline-catchup on boot (v1.1.x).
