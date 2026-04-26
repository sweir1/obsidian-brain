---
title: Changelog
description: User-facing release notes. For full commit detail, see GitHub Releases.
---

# Changelog

User-facing release notes. For full commit-level detail see [GitHub Releases](https://github.com/sweir1/obsidian-brain/releases).

## v1.7.14 — 2026-04-26 — Fix the npx-symlink silent crash (the actual fix v1.7.5 → v1.7.13 was hunting)

**This is the fix.** v1.7.13's debug trace empirically pinpointed the bug in production npx invocation; v1.7.14 corrects the main-entry guard so the symlinked invocation path actually starts the server.

### The bug, in one sentence

`process.argv[1] === fileURLToPath(import.meta.url)` is a structurally broken main-entry idiom under symlinked invocation: one side (`argv[1]`) is the symlink path Node was launched with, the other side (`import.meta.url`) is the real-file URL Node's ESM loader resolved through the symlink. They don't match. The `if` block is skipped. The event loop drains. The process exits with code 0. Claude Desktop sees stdio EOF and reports "transport closed unexpectedly" — with **no** error in the log because there was no error.

This affects **every** symlinked invocation path: npx (uses `.bin/<name>` symlinks), pnpm bin, yarn-link, manually-symlinked installs. It is independent of Node version and npm version — Talal hit it on Node 22.22.2 / npm 10.x; the user hit it on Node 24.14.1 / npm 11.12.1.

### The fix

`src/cli/index.ts` — three changes:

1. **Replace the inline strict-equality check with an `isMainEntry()` helper** that calls `realpathSync` on both sides before comparing. This normalizes any symlinked path on either side to the same target.

2. **Wrap realpathSync in try/catch** with a raw-comparison fallback. realpathSync throws ENOENT if argv[1] points to a non-existent path; the fallback preserves pre-v1.7.14 behaviour for that pathological case rather than making it worse.

3. **Realpath both sides, not just `argv[1]`.** Under `--preserve-symlinks` (deliberate Node opt-in) `import.meta.url` is the symlink URL — a one-sided realpath would re-introduce the asymmetry in the opposite direction. Cost is negligible (~50 µs total).

```ts
function isMainEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return argv1 === modulePath;
  }
}
```

### Why test imports stay broken (correctly)

vitest worker invokes the file as `import('…/src/cli/index.ts')`. `argv[1]` is the worker entrypoint, **not** cli/index.ts. realpath(worker) ≠ realpath(cli/index.ts), so `isMainEntry()` correctly returns false and `parseAsync` doesn't fire. Tests can import `buildProgram()` and snapshot help text without spawning the CLI. Existing `test/cli/help-snapshot.test.ts` exercises this path; it stayed green through the fix.

### Regression test

New `test/cli/symlink-invocation.test.ts` — two cases:

- Direct node invocation: `node dist/cli/index.js --version` returns the version string.
- Symlink invocation: creates a temp symlink to `dist/cli/index.js`, runs `node <symlink> --version`, expects the version string.

The symlink case **fails on v1.7.13 and earlier** (timeout or empty output, depending on how the test harness handles a clean exit-0 with no stdout). Passes on v1.7.14.

### What v1.7.5 → v1.7.13 actually fixed

Looking back, every release in the chain closed a real failure class — they were not wasted work, just not the failure mode that was firing in production:

- **v1.7.5** — bundled seed + metadata cache (HF outage protection)
- **v1.7.7** — preflight wrapper (catches native-module load crashes that fire before any try/catch is on the stack)
- **v1.7.8 / v1.7.10** — release-pipeline cache hygiene (prevents the rebuild-fail-silently-then-ship-broken-tarball class)
- **v1.7.11** — global error nets + `OBSIDIAN_BRAIN_DEBUG=1` startup trace (closes any future async-error silent-crash class)
- **v1.7.12** — module-load markers in heavy import paths (pinpoint which module was being evaluated when a transitive native crash happens)
- **v1.7.13** — argv-check diagnostic (the one that flushed THIS bug out)

Without that stack of layers, v1.7.14's diagnosis would have been impossible — every layer eliminated a different failure-mode hypothesis until only this one remained, and the final layer's debug log printed it character-for-character. All six layers stay in the codebase. They protect against future failure classes, even though THIS specific bug turned out to be one line of comparison logic at the bottom of cli/index.ts.

### Test totals
939 → 941 vitest passing (+2 from `symlink-invocation.test.ts`). Preflight 11/11 green.

## v1.7.13 — 2026-04-26 — Pinpoint the npx-symlink silent crash + 16 more module-load markers

**Diagnostic-only release.** No behaviour change for working installs. The new debug output, when `OBSIDIAN_BRAIN_DEBUG=1` is set, **empirically identifies the root cause** of the silent-crash class that has dogged v1.7.5 → v1.7.12: under npx invocation, the `cli/index.ts` main-entry guard never fires.

### The argv-check diagnostic (the big one)

The bottom of `src/cli/index.ts` has guarded the actual server bootstrap behind:

```ts
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildProgram().parseAsync(process.argv).catch(...)
}
```

The intent: only run as a CLI when executed directly, skip when imported by tests. Under `npx -y obsidian-brain@latest server`, npm creates a `.bin/obsidian-brain` symlink that points at `<pkg>/dist/cli/index.js`. Node sets `process.argv[1]` to the **symlink path** (the thing it was launched with), but `fileURLToPath(import.meta.url)` resolves through the symlink and returns the **real path**. They are not equal. The `if` block is skipped. No `parseAsync`. No async work. The event loop drains. The process exits cleanly with code 0. Claude Desktop sees stdio EOF and reports "transport closed unexpectedly, exiting early" — with **no** error in the log because there was no error.

This release adds debug logs on **both** branches of that check, so the trace shows exactly which branch was taken and the actual values of `argv[1]` vs `fileURLToPath(import.meta.url)`:

```
cli: about to check main-entry — argv[1]="/Users/u/.npm/_npx/<hash>/node_modules/.bin/obsidian-brain" import.meta.url="file:///Users/u/.npm/_npx/<hash>/node_modules/obsidian-brain/dist/cli/index.js" fileURLToPath="/Users/u/.npm/_npx/<hash>/node_modules/obsidian-brain/dist/cli/index.js"
cli: main-entry check FAILED — process will exit cleanly when event loop drains. argv[1]="…/.bin/obsidian-brain" fileURLToPath="…/dist/cli/index.js" — these don't match. Likely cause: invoked via symlink (npx .bin shim). Server will not start.
```

**Verified empirically.** Created `/tmp/sl/obsidian-brain-shim → dist/cli/index.js`, ran via the shim with `OBSIDIAN_BRAIN_DEBUG=1`, observed the FAILED branch fire with the exact paths above. Ran the same binary directly (no symlink), observed `cli: main-entry check PASSED — entry point reached, argv = ["server"]`. Reproduces deterministically.

This is the same bug Talal hit on Node 22.22.2 / npm 10.x — it has nothing to do with npm 11.x's stdio-pipe regression. v1.7.5 → v1.7.12 chased the wrong hypothesis. The actual fix (use `realpathSync` to resolve both sides of the comparison before comparing) lands in v1.7.14.

### 16 more `module-load:` markers

Continued the v1.7.12 pattern across every remaining src file that does non-trivial work at import time. When the trace cuts off mid-startup, the LAST `module-load:` line is the last module whose import phase completed — the next module's evaluation is where it died.

Markers added to:
- `src/cli/index.ts` (after all imports complete, after package.json read)
- `src/cli/models.ts` (commands subroutine)
- `src/config.ts` (env-var parsing, vault-path resolution)
- `src/embeddings/auto-recommend.ts`, `capacity.ts`, `chunker.ts`, `hf-metadata.ts`, `metadata-cache.ts`, `overrides.ts`, `presets.ts`, `seed-loader.ts`
- `src/obsidian/client.ts` (REST client to the desktop app)
- `src/search/unified.ts` (RRF fusion)
- `src/util/errors.ts` (error formatter)
- `src/vault/parser.ts`, `vault/writer.ts` (markdown round-trip)

All gated on `OBSIDIAN_BRAIN_DEBUG === '1'` via `debugLog`. Zero output / overhead when disabled — verified by `test/util/debug-log.test.ts`.

**`src/embeddings/prefetch.ts` deliberately excluded**: the initial v1.7.13 push added a marker there, which broke CI with `ERR_MODULE_NOT_FOUND: '../util/debug-log.js'`. Root cause: `scripts/prefetch-test-models.mjs` loads `prefetch.ts` via Node 24's native TS strip-only loader (plain `node scripts/…`, not tsx), and that loader resolves imports literally — it refuses to rewrite `.js` → `.ts` like vitest/tsx do. So adding any internal `.js`-extensioned import to `prefetch.ts` breaks the prefetch CI step. Reverted the marker, added a load-bearing comment in `prefetch.ts` so a future reader doesn't reintroduce it. `prefetch.ts` is a leaf helper on the CI / `models prefetch` CLI path — not on the MCP-server boot path — so it doesn't need the diagnostic marker anyway.

### Granular cli/index.ts logs

Beyond the argv-check diagnostic, added markers at every non-trivial step of `cli/index.ts`'s top-level evaluation so the trace shows progress through:
- `cli: 'server' subcommand action entered, calling startServer()` — before `await startServer()`
- `cli: startServer() returned (server is now running, awaiting transport messages)` — after, useful when the crash is mid-server, not pre-server

### Test totals
939 → 939 vitest passing. Preflight 11/11 green. YAML lint clean.

## v1.7.12 — 2026-04-26 — Cache MTEB venv (release pip-install ~60 s → ~1 s) + module-load debug markers

**Bundles two changes:** the venv-cache speedup for the release workflow, and an additional layer of `OBSIDIAN_BRAIN_DEBUG=1` debug instrumentation that pinpoints which heavy module dies during silent crashes.

### Module-load debug markers

Added `debugLog('module-load: <path>')` at the top of every heavy module's body so when `OBSIDIAN_BRAIN_DEBUG=1` is set, the trace shows the EXACT module that was being evaluated when a silent crash happened. ESM imports are evaluated depth-first synchronously — if a transitive native crash (e.g., `onnxruntime-node`'s `.node` binding fails to load with SIGSEGV/SIGABRT) happens during a module's import phase, JS error handlers can't catch it. But the LAST module-load log we see in the trace pinpoints which module's import chain was being evaluated.

Markers added to:
- `src/global-handlers.ts` (inline `writeSync` to avoid circular-import edge case at this critical point — module's whole purpose is registering process error handlers)
- `src/context.ts`, `src/server.ts` (already imported `debugLog`)
- `src/store/db.ts` (better-sqlite3 + sqlite-vec module-top-level)
- `src/embeddings/factory.ts` (presets glue)
- `src/embeddings/embedder.ts` (PRIME SUSPECT — first import is `@huggingface/transformers` which transitively loads `onnxruntime-node` native binding; the marker line `module-load: src/embeddings/embedder.ts (transformers loaded OK)` fires AFTER that import succeeds, so its absence in a debug trace pinpoints the culprit)
- `src/embeddings/ollama.ts`
- `src/embeddings/metadata-resolver.ts`
- `src/pipeline/indexer.ts`
- `src/pipeline/bootstrap.ts`
- `src/pipeline/watcher.ts`

All gated on `OBSIDIAN_BRAIN_DEBUG === '1'`. Zero output, zero overhead when disabled — verified by an existing in-process test in `test/util/debug-log.test.ts` (`debugLog() returns without invoking writeSync when DEBUG unset`).

**Diagnostic flow for a silent crash:**
1. Set `OBSIDIAN_BRAIN_DEBUG=1` in the MCP client config's env block
2. Restart the client
3. Read `~/Library/Logs/Claude/mcp-server-obsidian-brain.log`
4. The LAST `module-load:` line tells you which module was being evaluated when the crash happened
5. If that line is `embedder.ts (transformers loaded OK)`, the crash is in code AFTER transformers loaded
6. If that line is the previous module's marker (e.g., `store/db.ts`), the crash is in `embedder.ts`'s import chain — likely `@huggingface/transformers` → `onnxruntime-node`

### Venv cache (the original v1.7.12 change)

**No user-visible runtime change. Release-process hygiene only — does not alter anything that ships in the npm tarball.**

Pre-v1.7.12 we cached `~/.cache/pip` (pip's wheel + http download cache) from a `ci.yml` main-push job, scoped to `refs/heads/main` so tag-pushed `release.yml` runs read it via cross-ref fallthrough. That worked — cache hit on every release tag — but `pip install -r scripts/requirements-build-seed.txt` still ran end-to-end on each release: parse the manifest, resolve the dep graph, copy ~thousands of wheel files into a fresh site-packages. ~60 s.

v1.7.12 caches the **entire populated venv at `~/.venv-mteb`** instead. On a hit, site-packages is already there and release.yml runs `~/.venv-mteb/bin/python scripts/build-seed.py` directly — pip is not invoked. Reported speedup for similar MTEB/torch stacks: ~60 s → ~1 s on hit (Adam Johnson, Simon Willison, AI2 ML team writeups).

- **`.github/workflows/ci.yml`** — `warm-mteb-pip-cache` job renamed to `warm-mteb-venv`. Now creates a venv at `~/.venv-mteb`, runs `pip install` *into the venv* on cache miss, saves the entire `~/.venv-mteb` directory. The job stays gated on `github.ref == 'refs/heads/main' && github.event_name == 'push'` so dev / PR runs don't pay the install cost.

- **`.github/workflows/release.yml`** — `Restore MTEB pip cache` step replaced with `Restore MTEB venv`. The `Install mteb` step is now conditional (`if: cache-hit != 'true'`) and creates the venv as a fallback only when the cache miss is real. The `Regenerate model seed JSON` step uses `~/.venv-mteb/bin/python` directly. On a cache hit (the common path), zero pip invocations happen — venv hits, build-seed runs, done.

- **Cache key includes the FULL Python patch version** (e.g. `py3.12.8`, not `py3.12`). Patch drift breaks venvs in two ways: (1) the venv's `bin/python` shebang references a Python that may not exist on the new runner image, and (2) native extensions in torch/scipy are compiled against a specific Python ABI. Embedding the full version means a runner image's Python patch bump triggers a clean miss → rebuild → save under a new key, rather than a partial restore that fails at runtime. Documented case study at `luke.hsiao.dev` for why patch-level keying matters.

- **No `restore-keys` fallback.** Same reason: a fuzzy fallback that matches `py3.12.7` against a `py3.12.8` runtime is exactly the failure mode we want to avoid. Cache miss → clean rebuild is the safe default.

- **Manifest hash in the key.** `hashFiles('scripts/requirements-build-seed.txt')` means any constraint change (e.g. mteb major bump) automatically triggers a new cache key without manual `-v1` → `-v2` work. Manual cache-buster suffix is still there for situations where we need to force a rebuild without changing the manifest (e.g. CVE patch in a transitive dep cached pre-fix).

- **Bootstrap path:** v1.7.12's release run gets a cache MISS (key changed from `mteb-pip-2.12-v1` to the new venv key — different shape). It rebuilds + saves the venv to main scope. v1.7.13+ release tag pushes get the fallthrough hit and skip pip install entirely.

### Test totals
939 → 939 vitest passing. The 11 module-load debug markers add one debug-call line per module — gated on env var, no-op in tests (which don't set `OBSIDIAN_BRAIN_DEBUG=1`). Existing test suites confirm the gate works. Preflight 11/11 green. YAML lint clean.

## v1.7.11 — 2026-04-26 — Global error nets + `OBSIDIAN_BRAIN_DEBUG=1` startup trace + enriched boot banner

**Diagnostic infrastructure release.** Doesn't fix the npm 11.x npx-stdin bug (out of our control) but converts every silent crash class — present and future — into a noisy crash with a recoverable error log on disk.

### Global error nets

- **`src/global-handlers.ts`** — registers `process.on('uncaughtException')` and `process.on('unhandledRejection')` at module-import time, immediately after `preflight.ts` in `cli/index.ts`. Both handlers write synchronously to fd 2 via `fs.writeSync(2, …)` AND to `~/.cache/obsidian-brain/last-startup-error.log`. Both call `process.exit(1)` only AFTER the sync writes return. Closes the silent-crash class that bit the v1.7.5/v1.7.6/v1.7.7 cohort: any async error that escapes our explicit `parseAsync().catch` in `cli/index.ts` and `startServer().catch` in `server.ts` (chokidar event handlers, MCP SDK transport callbacks, transitive-dep EventEmitters, fire-and-forget `void (async () => …)()` blocks, `setTimeout` callbacks) used to fall through to Node's default handler — which writes async to stderr and races the implicit exit. Now the same error path is fully synchronous and recoverable.

- **Marker line in the crash log** distinguishes the new failure types from preflight's native-module-load crashes:
  ```
  # obsidian-brain unhandled-rejection
  timestamp: 2026-04-26T...
  type:      unhandled-rejection
  node:      v24.14.1
  abi:       137
  platform:  darwin-arm64
  ```

- **Tests:** new `test/global-handlers.test.ts` (9 cases): `recordCrash` shape for both kinds, non-Error reasons via `String()` coercion, file-write failure tolerance, `process.exit(1)` invocation on the handler path, listener registration on import. Plus new `test/util/debug-log.test.ts` (16 cases): gate behavior across all env-var values, in-process write verification via `vi.mock('node:fs')` for clean coverage credit AND a child-process suite that spawns a real Node process to verify actual stderr output end-to-end. Both files keep the test runner's stderr clean — `vi.mock` replaces `fs.writeSync` with a `vi.fn()` so the in-process tests don't pollute test output.

### `OBSIDIAN_BRAIN_DEBUG=1` startup trace

- **`src/util/debug-log.ts`** — synchronous stderr trace gated on `OBSIDIAN_BRAIN_DEBUG=1`. Same `fs.writeSync(2, …)` pattern so the LAST debug line before a crash always reaches the MCP client's stderr. Format: `obsidian-brain debug [+<ms>]: <msg>` with monotonic milliseconds since process start.

- **Read at the absolute earliest moment.** `OBSIDIAN_BRAIN_DEBUG` is captured as the **first executable statement of `src/preflight.ts`** — before `createRequire`, before native-module loads, before any other top-level work. Defensive design: even an unforeseen module-init crash still has the debug trace function armed and ready to fire on the LAST step before the crash. The first two debug lines (`preflight: module loaded (debug mode active)` and `preflight: createRequire resolved`) appear BEFORE the boot banner when debug mode is on, confirming the env var was read before any other state was evaluated.

- **Boot banner shows debug status.** The standard banner now ends with `debug=on` or `debug=off` so users can confirm at boot — without enabling trace mode — whether the env var was read correctly:
  ```
  obsidian-brain: starting (v1.7.11, Node v24.14.1, NODE_MODULE_VERSION 137, npm 11.12.1, platform darwin-arm64, debug=on)
  ```

- **Trace points wired into the entire startup path** (~25 checkpoints):
  - `preflight.ts` — per-native-module load attempt + result
  - `cli/index.ts` — entry argv + `server` subcommand action entry/exit
  - `context.ts` — resolveConfig → openDb → createEmbedder → wiring complete
  - `server.ts` — startServer entry → tools registered → `dbIsEmpty` decision → `server.connect` before/after → background block entry/exit → watcher → signal handlers → orphan-PPID watchdog → return
  - `server.ts` — shutdown invocation, watcher close, embedder dispose, DB close, teardown errors

- **No-op when not enabled** — single env-var check up-front, debug calls early-return. No measurable overhead in production.

- **How to enable** in any MCP client config (`claude_desktop_config.json`, etc.):
  ```json
  "env": { "OBSIDIAN_BRAIN_DEBUG": "1", "VAULT_PATH": "..." }
  ```
  Trace appears in `~/Library/Logs/Claude/mcp-server-obsidian-brain.log` on macOS. The LAST line before any silent failure tells the user (and us) exactly which step the server reached before things went wrong.

### Enriched boot banner

- **`preflight.ts` banner now includes**:
  - **obsidian-brain version** (read from `package.json` via `createRequire`)
  - **npm version** (parsed from `process.env.npm_config_user_agent` — set by npm/npx when they spawn us; `n/a` when invoked via raw `node`)
  - Existing fields: Node version, `NODE_MODULE_VERSION` ABI, platform-arch
  ```
  obsidian-brain: starting (v1.7.11, Node v24.14.1, NODE_MODULE_VERSION 137, npm 11.12.1, platform darwin-arm64)
  ```
  Diagnostic for the npm 11.x stdio-pipe bug: a log entry showing `npm 11.x` immediately implicates that bug class. A log entry showing `npm n/a` confirms the user is invoking us via `node` directly (the workaround).

### What this DOES NOT fix

- **Sammy's bug (npm 11.x stdio detach via `npx -y obsidian-brain@latest`)** — out of our control, lives in npm's wrapper. Workaround: use `npx -y /abs/path/dist/cli/index.js server` (skips npm's install machinery) or `node /abs/path/dist/cli/index.js server` directly.

- **Talal's bug (silent 2.4 s exit on Node 22 / npm 10.x)** — we can't reproduce locally, but v1.7.11 makes the next occurrence diagnose itself: any unhandled error will land in `~/.cache/obsidian-brain/last-startup-error.log`, and `OBSIDIAN_BRAIN_DEBUG=1` will print exactly which step the server reached.

### Test totals

902 → 939 vitest passing (added 9 cases for `global-handlers.test.ts` + 16 cases for `debug-log.test.ts` + 2 README dead-link tests already shipped in v1.7.9). Preflight 11/11 green (added `gen-readme-recent --check` step).

## v1.7.10 — 2026-04-26 — Move MTEB pip cache save to `ci.yml` on main pushes (cross-tag fallthrough)

**No user-visible runtime change. Release-process hygiene only.**

v1.7.8 added a manual `actions/cache/save@v5` for the MTEB pip cache inside `release.yml`, which fires on tag pushes. Each release saved a 2.7 GB cache, but the next release tag couldn't read it. v1.7.9's `gh cache list` showed the smoking gun — two separate caches with the same key under different ref scopes:

```
2026-04-26T12:14:03Z refs/heads/refs/tags/v1.7.9 mteb-pip-2.12-v1 (2730 MB)
2026-04-26T12:04:29Z refs/heads/refs/tags/v1.7.8 mteb-pip-2.12-v1 (2730 MB)
```

Per [GitHub Actions cache docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching):

> "Workflow runs cannot restore caches created for different tag names. A cache created for the tag release-a with the base main would not be accessible to a workflow run triggered for the tag release-b."

The HF embedding-models cache pattern in `ci.yml` doesn't have this problem — caches saved on the **default branch (main)** automatically fall through to all other refs (branches AND tags). The fix mirrors that: save on a workflow that runs on `push: main`, restore from any ref via cross-ref fallthrough.

- **`.github/workflows/ci.yml`** — added a new parallel `warm-mteb-pip-cache` job, gated on `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`. Same split-restore/save pattern as the existing HF cache. Self-throttling — when the cache is already warm (the common case), the job finishes in ~10 s and skips both install and save. Only fires the 60-second pip install + 2.7 GB upload on a true miss (after a deliberate `-v1` → `-v2` key bump). Doesn't run on dev pushes or PRs.

- **`.github/workflows/release.yml`** — kept the `Restore MTEB pip cache` step (now hits main's cache via fallthrough), removed the `Save MTEB pip cache` step (was creating useless tag-scoped caches). The `Install mteb` step keeps `pip install -r ...` so it can read the restored wheels and produce `Using cached <wheel>` output instead of `Downloading <wheel>`.

- **What this fixes for users:** every release ran ~60 seconds of pip install + 2.7 GB cache upload, completely wasted because no future release could read it. After v1.7.10 is merged to main, the next ci.yml main push warms the cache once. Every subsequent release tag push reads it instantly. Saves ~60 s + 2.7 GB per release going forward.

- **Bootstrapping:** v1.7.10's promote tag push will fire release.yml first (cache miss, install runs as before), then ci.yml on the merge-back commit warms main's cache. v1.7.11+ release tag pushes get the fallthrough hit.

## v1.7.9 — 2026-04-26 — README "Recent releases" heading restore + new dead-link test for README

**Docs hygiene only — no runtime change.**

- **Restored the `## Recent releases` heading in README.md.** When v1.7.8 added `<!-- GENERATED:recent-releases -->` markers around the bullet list, the heading immediately above was deleted alongside the old hand-maintained content. The bullets rendered fine but had no header above them, leaving the page-anchor `[Recent releases](#recent-releases)` in the README's table-of-contents (top of the file) silently broken. Heading restored above the marker block. `gen-readme-recent --check` confirms the markers + content are otherwise unchanged.

- **New `test/docs/readme-links.test.ts` — catches dead links in README.md going forward.** Vitest suite that parses every markdown link in README and validates:
  - **Internal anchors** (`[text](#slug)`) — must match an `## Heading` in README.md. Catches the v1.7.8 regression directly: deleting `## Recent releases` would have failed this test before v1.7.9 shipped.
  - **Relative paths** (`[text](docs/foo.md)`, `[text](LICENSE)`) — must exist on disk. Catches typos and references to docs that were renamed/deleted without a README sweep.
  - **Anchored relative paths** (`[text](docs/foo.md#section)`) — file must exist AND the anchor must resolve to a heading in that file.
  - **External URLs** (`https://`, `mailto:`, `tel:`) — skipped. Network-dependent, flaky; link-rot needs a different cadence (weekly cron, not per-commit).
  - **Code blocks** — fenced ```code``` and inline `code` are stripped before parsing so example URLs in documentation don't get validated.
  
  Slug algorithm mirrors GitHub's heading-anchor rule: lowercase, strip non-(word|space|hyphen) chars, collapse whitespace to single hyphens. Verified against the README's own table-of-contents at the top of the file as the canonical fixture. Sanity guard requires the parser to find at least 10 links — catches the case where someone accidentally breaks the regex and the suite passes vacuously.

- **`docs/**.md` already covered by `mkdocs build --strict`** in the `docs:build` preflight + CI step, so this new suite stays focused on README.md (which mkdocs doesn't render).

- **Test totals:** 902 → 906 vitest passing.

## v1.7.8 — 2026-04-26 — Fix `EMBEDDING_PRESET=multilingual-ollama` silently using `nomic-embed-text` + consolidate preset resolution

**Bug fix.** Pre-v1.7.8, setting `EMBEDDING_PRESET=multilingual-ollama` (added in v1.7.5 Plan B to use `qwen3-embedding:0.6b`) silently fell through to the hardcoded Ollama default `nomic-embed-text`. Users without `nomic-embed-text` pulled in their local Ollama saw startup failures (`HTTP 404 Not Found — model "nomic-embed-text" not found`); users WITH `nomic-embed-text` pulled got the wrong model embedded into their vault. The preset-declared model (`qwen3-embedding:0.6b`) was never reaching the OllamaEmbedder constructor.

**Root cause.** `src/embeddings/factory.ts:28` Ollama branch resolved the model independently of the preset registry: `const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'`. The transformers branch (line 47) correctly called `resolveEmbeddingModel(process.env)` which honors `EMBEDDING_PRESET`; the ollama branch never did. `resolveEmbeddingProvider` would correctly read the preset and return `'ollama'`, but once inside the ollama branch the preset's declared model was silently dropped. Architectural drift introduced when v1.5.0-F first added the Ollama provider; never noticed because the unit tests for `resolveEmbeddingModel` passed (the function works correctly in isolation) and there was no integration test for `createEmbedder()` that exercised the preset → embedder path end-to-end.

- **`src/embeddings/presets.ts` is now the single source of truth** for everything preset-related:
  - **`EMBEDDING_PRESETS`** — the 6-preset registry (unchanged data; new `as const satisfies` shape carries through to consumers).
  - **`DEFAULT_PRESET = 'english'`** — name of the preset that applies when no preset/model is set. Replaces hardcoded `'english'` strings scattered across resolvers.
  - **`DEFAULT_OLLAMA_MODEL = 'nomic-embed-text'`** — the Ollama model used as a fallback when the user explicitly sets `EMBEDDING_PROVIDER=ollama` without naming a model or a matching preset. Replaces TWO parallel hardcodes (factory.ts + ollama.ts constructor default).
  - **`resolvePresetConfig(env)`** — the new atomic resolver. Returns `{ provider, model, presetName, source }` together so consumers can't desync the (provider, model) pair. Every consumer must call this; re-implementing env-var precedence locally is the architectural mistake we just lived through.
  - **`resolveEmbeddingProvider` / `resolveEmbeddingModel`** — kept as thin back-compat wrappers around `resolvePresetConfig`. Existing callers (`auto-recommend.ts`, `cli/models.ts`, every test file) keep working unchanged.

- **`src/embeddings/factory.ts` — the actual fix.** Collapsed to a single `resolvePresetConfig(process.env)` call at the top, then branches on `cfg.provider` and uses `cfg.model`. There is no longer any path through `createEmbedder()` where provider and model can desync. Bug 2 is structurally impossible.

- **`src/embeddings/ollama.ts:37`** — constructor's `model` default-param was a parallel hardcode of `'nomic-embed-text'`. Now imports and uses `DEFAULT_OLLAMA_MODEL`. Changing the Ollama default in the future is one line, one file.

- **New behavior — provider/preset mismatch warning.** Setting `EMBEDDING_PROVIDER=ollama` together with `EMBEDDING_PRESET=english` (a transformers preset) used to silently fall through to `nomic-embed-text` regardless of what `english` declared. Now resolves to `provider='ollama' + model='Xenova/bge-small-en-v1.5'` (preset's model carried over) and emits a one-shot warning explaining the conflict — the runtime failure that follows has context. Users who hit this should remove one of the env vars.

- **9 new regression tests in `test/embeddings/factory.test.ts`.** The integration gap that let Bug 2 ship is closed by a property-based suite that iterates `EMBEDDING_PRESETS` at test time and asserts every preset survives the `createEmbedder()` round-trip with the correct (provider, model) pair attached. Adding a new preset to `EMBEDDING_PRESETS` automatically extends this suite — no test edit needed. Changing a preset's underlying model also requires no test edit (the assertion is "factory returns whatever the preset declares", not "factory returns this specific string"). The change-detector signal for intentional preset-model swaps lives separately in `test/cli/models.test.ts`'s `models list` snapshot.

- **No user action required for users on the affected preset.** If you were running with `EMBEDDING_PRESET=multilingual-ollama` and explicit `EMBEDDING_MODEL=qwen3-embedding:0.6b` as the documented workaround: the workaround keeps working — `EMBEDDING_MODEL` still wins on precedence. Removing the workaround now also works (`EMBEDDING_PRESET` alone resolves correctly). If you were running without the workaround and getting `nomic-embed-text` errors: a fresh boot on v1.7.8 will trigger a model-change reindex (the bootstrap detects `nomic-embed-text → qwen3-embedding:0.6b` and re-embeds), so plan ~5–15 minutes of background reindex on a typical vault.

- **Test totals:** 893 → 902 vitest passing. Preflight 10/10 green.

- **Stale entry pruned from `docs/models.md` license catalogue.** `Xenova/paraphrase-MiniLM-L3-v2` was listed in the MIT row of the license catalogue at line 258 even though it stopped being a preset model in v1.7.4 (replaced by `MongoDB/mdbr-leaf-ir`). The only remaining mention in the body is the historical breadcrumb `v1.7.4: replaced \`Xenova/paraphrase-MiniLM-L3-v2\`` on line 17, which is fine — but listing a no-longer-supported model alongside current presets in a license catalogue implied users could still pick it. Removed. Cross-checked every other entry: all 14 remaining entries are either current presets or documented BYOM ("bring your own model") recipes with body sections matching them, so the table is now consistent.

### Also in v1.7.8 — Stop the churning MTEB pip cache in `release.yml` (release-process hygiene)

**No user-visible runtime change** — does not alter anything that ships in the npm tarball.

Replaces `actions/setup-python@v6`'s built-in `cache: pip` (added in v1.7.6) with the same explicit `actions/cache/restore@v5` + `actions/cache/save@v5` split-pattern that `ci.yml` already uses for the Hugging Face embedding-models cache.

- **Symptom (observed v1.7.6 → v1.7.7):** every release run uploaded **2.88 GB** of pip-cached wheels to GitHub Actions cache, even though the requirements file (`scripts/requirements-build-seed.txt`) hadn't changed. Cache restore reported a partial fallback hit (~25 MB under an old key like `…-pip-4956364a…`), pip re-downloaded the rest, and the post-step saved a fresh tarball under a new exact key (`…-pip-c5a61df2…`). Same content, new key, every run.

- **Root cause:** `setup-python@v6`'s cache key includes runner-image-derived inputs that drift between runs even when the dependency manifest is unchanged. Restore vs save compute different hashes → no exact-key hit → save fires unconditionally.

- **Fix:** key the cache on a **stable hardcoded string** (`mteb-pip-2.12-v1`) rather than a churn-prone derived hash. Mirrors the pre-existing HF cache pattern in `ci.yml:69-126`:
  - `actions/cache/restore@v5` BEFORE `pip install`, `continue-on-error: true`, with a `restore-keys` fallback chain (`mteb-pip-2.12-`, `mteb-pip-`).
  - `actions/cache/save@v5` AFTER `pip install`, gated by `if: steps.install-mteb.outcome == 'success' && steps.mteb-pip-restore.outputs.cache-hit != 'true'` — only saves when install succeeded AND wasn't already an exact-key hit.
  - Cache-bust mechanism is explicit: bump `-v1` → `-v2` to retire stale wheels (e.g. CVE patch in a transitive dep), or bump prefix to `mteb-pip-3.x-v1` when MTEB ships 3.0.

- **Two release-runs to fully benefit:** the v1.7.8 run itself populates the new stable key for the first time (same wall-time as v1.7.7). The v1.7.9 run hits the exact key, reads wheels locally (~10–15 s vs ~60 s of network downloads), skips the 2.88 GB upload entirely. Subsequent runs stay cache-hit until the manifest or `-v1` suffix changes.

- **Seed-regen step itself is unchanged.** `scripts/build-seed.py` still runs after `pip install -r scripts/requirements-build-seed.txt`, still has `continue-on-error: true` so a failure doesn't block the release (committed `data/seed-models.json` ships if regen fails). All three of the `Setup Python` / `Install mteb` / `Regenerate model seed JSON` steps still ride the same release-only tag-trigger gate.

## v1.7.7 — 2026-04-26 — Surface silent native-module crashes (preflight wrapper + sync stderr writes + un-masked postinstall + Node-identity banner)

**Fixes the silent-crash failure mode** where Claude Desktop's MCP transport spawns the npx-cached obsidian-brain after a Node version change, the cached `better_sqlite3.node` is incompatible with the current Node, and the process dies with **no error visible in `~/Library/Logs/Claude/mcp-server-obsidian-brain.log`**. Two underlying causes stacked: top-level `import` of native modules can fail before any user-code try/catch is on the stack, and `process.stderr.write(msg) + process.exit(1)` races with Node's async stderr buffer so the error message can be discarded before reaching the OS pipe. Both addressed.

- **`src/preflight.ts`** — new module, MUST be the first import in `src/cli/index.ts`. Uses `createRequire(import.meta.url)` to load `better-sqlite3` and `sqlite-vec` synchronously inside try/catch (static `import` can't go inside try/catch — syntax error — but `createRequire`-style `require()` calls can). On the happy path: ~10 ms tax, modules cached in Node's require map, downstream ESM `import` statements in `src/store/db.ts` hit cache and skip the load entirely. On failure: writes a banner + the full error stack to fd 2 via **synchronous `fs.writeSync(2, …)`** (bypasses Node's async Writable buffer — bytes always reach the pipe before exit), AND writes the same content to `~/.cache/obsidian-brain/last-startup-error.log` as a recoverable record if the MCP client's stderr capture loses the message anyway. Then dispatches to the auto-heal in `src/auto-heal.ts` to spawn a background rebuild + tell the user to restart their MCP client.

- **`src/auto-heal.ts`** — new file extracted from the bottom of `src/context.ts` (was a 200-line block at lines 161–365). Now standalone, parameterised by failing module (`'better-sqlite3' | 'sqlite-vec'`), reachable from preflight without circular-importing `context.ts`. The error-pattern matcher (`isLikelyAbiFailure`) is broadened from `/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/` to also catch `was compiled against a different Node\.js version`, `dlopen.*Symbol not found`, `dlopen.*image not found`, `incompatible architecture`, and the `Cannot find module 'sqlite-vec...'` symptom that surfaces when a platform-specific optional-dep package is missing. `src/context.ts`'s in-`openDb` catch still calls into this module — the second-line-of-defence path covers the case where `import` succeeded but `new Database()` throws at construction time. New `test/auto-heal.test.ts` (8 unit cases) covers the matcher; existing `test/context.test.ts` covers the dispatch.

- **Sqlite-vec auto-heal path** — `tryAutoHealAbiMismatch` now accepts `module` and routes to the right command. For `better-sqlite3`: existing `npm rebuild better-sqlite3`. For `sqlite-vec`: new `npm install --no-save sqlite-vec-${process.platform}-${process.arch}` (the platform-specific optional dep). Marker filename gains the module name (`abi-heal-attempted-better-sqlite3-<abi>` / `abi-heal-attempted-sqlite-vec-<platform>-<arch>`) so the two heal paths don't share a cooldown. Pre-v1.7.7 markers (`abi-heal-attempted-<abi>` only) are now obsolete; the test suite cleans both old and new on `beforeEach`.

- **`process.stderr.write` → `fs.writeSync(2, …)`** in every catch handler that follows with `process.exit(1)`: `src/cli/index.ts` `parseAsync().catch`, `src/server.ts` `startServer().catch`, `src/preflight.ts`. Synchronous OS-level write blocks until bytes are accepted by the pipe; the subsequent `process.exit` no longer races. Closes the failure mode where Apr 22–23 crashes printed errors but the 2026-04-26 02:10 crash didn't — same root cause, different timing on the buffer-flush race.

- **Node-identity banner** — first line on every boot, written via `fs.writeSync(2, …)` from `runPreflight`:
  ```
  obsidian-brain: starting (Node v24.14.1, NODE_MODULE_VERSION 137, platform darwin-arm64)
  ```
  Always lands in Claude Desktop's log even on immediate crash. Diagnosing future ABI mismatches starts with "what Node was active that boot?" — this answers it without the user having to run anything.

- **`package.json` postinstall un-masked** — `"npm rebuild better-sqlite3 || true"` → `"npm rebuild better-sqlite3 || (echo 'obsidian-brain: postinstall rebuild ... FAILED ...' 1>&2; exit 1)"`. The `|| true` suffix was silently masking rebuild failures, leaving installs in a half-broken state that crashed on first boot. Now the failure surfaces immediately during `npm install` / `npx -y obsidian-brain@latest` with an actionable recovery message + link to troubleshooting docs. Only triggers for users on Node versions with no prebuild AND no C++ toolchain — an existing failure case that v1.7.7 just makes visible instead of silent.

- **CRASH RECOVERY (existing path, now reachable)** — when the failure recurs (and it will, every time a user upgrades Node while the npx cache holds a stale obsidian-brain), users see:
  ```
  obsidian-brain: ✗ Native module load failed before server could start.
    Module:  better-sqlite3
    Node:    v24.14.1 (NODE_MODULE_VERSION 137)
    Detail:  ~/.cache/obsidian-brain/last-startup-error.log

  Auto-heal: a background rebuild was started (PID 12345). Restart your
  MCP client (⌘Q + reopen) in about 1 minute.

  If the problem persists after restart:
    rm -rf ~/.npm/_npx
  ```
  Both Claude Desktop's log AND the local diagnostic file capture the same content. No more silent crashes.

- **Coverage** — `src/preflight.ts` and `src/context.ts` added to `vitest.config.ts` `coverage.exclude` per the project's existing grandfather-via-exclude policy. Preflight is process-startup-glue that can't be meaningfully unit-tested without breaking the runner; context.ts's remaining content after the auto-heal extraction is end-to-end glue (vault open, DB open, embedder factory wiring) covered by `scripts/mcp-smoke.ts` and `test/integration/*` which spawn real subprocesses V8 coverage doesn't follow into. Final totals: **893/893 vitest, 38/38 Python**, preflight 10/10 green.

## v1.7.6 — 2026-04-26 — Release-flow drift guard + revert redundant docs-deploy step + pip caching for build-seed

**No user-visible runtime change.** Internal release-process hygiene
after the v1.7.5 ship-day surfaced two real flaws.

- **Stale `dev-shipped` drift guard** in `scripts/promote.mjs`. The
  v1.7.3 ship attempt failed because the `dev-shipped` tag was at a
  pre-v1.7.0 commit (someone shipped earlier releases without
  advancing the tag) and `promote` tried to re-cherry-pick all of
  v1.7.0/v1.7.1/v1.7.2 onto main, conflicting on the first commit.
  After computing pending, the guard now scans `git log --first-parent
  dev-shipped..target` for any commit whose subject matches
  `^v?\d+\.\d+\.\d+$` — that regex matches the bare-version-string
  commits `npm version` produces and which arrive on dev's
  first-parent line via the merge-back step of every release. Their
  presence in the pending range proves at least one full release
  shipped without `dev-shipped` being advanced; the guard aborts
  before any cherry-pick with the exact recovery command pointing
  the tag at the newest version-bump anchor in the range. Zero
  impact on the happy path. Triggers only when drift exists.
  RELEASING.md gains a "Stale dev-shipped tag" section documenting
  the failure mode + fix.
- **Reverted the v1.7.5 docs-rebuild step from `release.yml`.** The
  step duplicated work that `.github/workflows/docs.yml` has been
  doing since 2026-04-24 — build the site with `mkdocs --strict`,
  upload via `actions/upload-pages-artifact`, deploy via
  `actions/deploy-pages` (artifact-based, no branch). v1.7.5's
  release.yml addition used `peaceiris/actions-gh-pages@v3` which
  uses a different deployment model (push to a `gh-pages` branch).
  The repo's Pages config is `build_type: workflow`, so it doesn't
  read from any branch; peaceiris's gh-pages branch was dead
  weight. The v1.7.5 site update came from `docs.yml`'s artifact
  deploy, not from peaceiris. Removed the 4-step block, the
  `pages: write` permission, and the `environment: github-pages`
  job binding from release.yml. Existing orphan `gh-pages` branch
  deleted from origin.
- **Pip caching for the build-seed step.** Bumped the build-seed
  step's `actions/setup-python@v5` → `@v6` (Node 24, kills the
  remaining deprecation warning in this workflow) and added
  `cache: pip` + `cache-dependency-path: scripts/requirements-build-seed.txt`.
  The MTEB pin moves from inline `pip install 'mteb>=2.12,<3'` into
  the new requirements file so setup-python's pip cache keys off the
  file's hash. Cold release is unchanged; warm release skips the
  ~30s mteb install.

## v1.7.5 — 2026-04-25 — Six-layer metadata-resolver chain (overrides → cache → seed → HF → probe → fallback) + Ollama parity (tag-swap detection + `/api/show` capacity + override flow-through) + four new `models` CLI subcommands (`add` / `override` / `fetch-seed` / `refresh-cache`) + `multilingual-ollama` preset → `qwen3-embedding:0.6b` + friendly `UserError` CLI formatting + doc-drift invariant tests

**Mostly invisible upgrade, with one preset model swap.** Five of the six canonical presets (`english`, `english-fast`, `english-quality`, `multilingual`, `multilingual-quality`) are unchanged in shape — same prefix, same dim, same chunk budget — they're just sourced from upstream HF configs (via a bundled `data/seed-models.json` refreshed at every release) and cached in `embedder_capability` instead of hardcoded across `presets.ts` / `embedder.ts` / `capacity.KNOWN_MAX_TOKENS`. The sixth preset, `multilingual-ollama`, swaps its underlying model from `bge-m3` to `qwen3-embedding:0.6b` (+4.77pp MTEB-multilingual; existing preset users auto-reindex on next boot — `ollama pull qwen3-embedding:0.6b` first). Ollama users on asymmetric models (nomic / qwen / mxbai families) also get a one-time reindex now that override-flowed prefixes actually take effect.

For BYOM users (`EMBEDDING_MODEL=any/hf-id`): the resolver fetches dim / max-tokens / query+document prefixes live from HF on first use and caches them per-vault forever (invalidate explicitly via `obsidian-brain models refresh-cache`). Wrong-prefix bugs (the kind that would have shipped a wrong-flip prefix by hand) become impossible — the source of truth is upstream HF configs (or the user's own override file via `models override`), not us.

### Resolver chain — six layers, override → cache → seed → HF → embedder probe → fallback

- **Layer 0: user-config overrides** (`src/embeddings/user-config.ts`, `src/embeddings/overrides.ts`) — two new files live in `~/.config/obsidian-brain/` (XDG-compliant; `%APPDATA%/obsidian-brain/` on Windows; `$OBSIDIAN_BRAIN_CONFIG_DIR` overrides everything). Because they're outside the npm package directory, both `model-overrides.json` and the user-fetched `seed-models.json` survive `npm update` intact. Override changes auto-trigger a re-embed via the existing prefix-strategy hash in `bootstrap.ts`; `maxTokens` overrides take effect on the next reindex.
- **Layer 1: pure HF API client** (`src/embeddings/hf-metadata.ts`) — `getEmbeddingMetadata(modelId)` fetches `config.json` + `tokenizer_config.json` + `sentence_bert_config.json` + `config_sentence_transformers.json` + `modules.json` in parallel, plus the upstream `base_model`'s `config_sentence_transformers.json` when the direct repo lacks `prompts`. AbortController-based timeout (5s default), 2 retries with backoff. Multimodal / vision / audio models throw cleanly. Zero project coupling — mockable via `vi.spyOn(global, 'fetch')`.
- **Layer 2: bundled seed loader** (`src/embeddings/seed-loader.ts`) — reads `data/seed-models.json` once at startup, exposes a typed `Map<modelId, SeedEntry>`. The user-fetched path at `~/.config/obsidian-brain/seed-models.json` (managed via `models fetch-seed`) takes priority over the bundled npm-tarball copy when present. Bad shape / missing file → empty map + stderr warning, never crashes. JSON imports use `tsconfig.resolveJsonModule` (already enabled).
- **Layer 3: resolution chain** (`src/embeddings/metadata-resolver.ts`) — pure function with all deps injected. Order: cache → bundled seed → HF live → embedder probe → safe defaults. **Cache lives forever once written**; users invalidate explicitly via `npx obsidian-brain models refresh-cache [--model <id>]`. No TTL, no stale-while-revalidate, no background refetches — the v7 metadata fields (`dim`, `model_type`, `hidden_size`, ONNX size) are immutable for a given HF id, and the rare fields that CAN change post-publish (tokenizer config corrections, retroactively-added prompts) are cheaper to handle via explicit user action than via constant background HF traffic. Sync variant (`resolveModelMetadataSync`) for the bootstrap prefix-strategy hash.
- **Layer 4: cache persistence** (`src/embeddings/metadata-cache.ts`) — schema v7 columns on `embedder_capability` (`dim`, `query_prefix`, `document_prefix`, `prefix_source`, `base_model`, `size_bytes`, `fetched_at`). `clearMetadataCache(db, modelId?)` nulls the v7 columns on demand (preserves v6 capacity columns); backs the `models refresh-cache` CLI subcommand.
- **Schema v7 migration** — adds the seven nullable columns to `embedder_capability` via idempotent `ensureEmbedderCapabilityV7Columns(db)`. Existing v6 rows untouched. `selfCheckSchema` extended to verify + heal the new columns.
- **Resolver short-circuit when override is complete** (Step 0 ahead of cache lookup) — when the user override fully specifies `maxTokens`, `queryPrefix`, AND `documentPrefix`, skip the entire chain and return the override directly (cached as `prefixSource: 'override'`). This makes `models add` truly zero-network for the registered id; partial overrides still flow through cache → seed → HF as before.
- **`prefixSource: 'override'` cache marker** — added to the `CachedPrefixSource` union and propagated through `EmbedderMetadata` / `ResolvedMetadata`. `materialise()` now surfaces an `overrideApplied: boolean` field on the resolved metadata so `index_status` / future debug commands can distinguish "the seed says X" from "the user overrode X to Y". Override-applied entries cache as normal; only the marker differs.
- **Tier 3 README fingerprinting deferred** (`src/embeddings/hf-metadata.ts`) — exploratory implementation lives in the file (`resolvePromptsFromReadme`, language-aware script filter, tightened `isPlausiblePrefix`) but is **not wired into the live resolver chain**. False-positive risk on long-form READMEs is too high to ship without an eval harness; deferred to a future release. The resolver chain stops at HF live fetch + embedder probe + safe defaults for now. The exploratory function and its bug fixes (BGE-en/zh script filter, `print()`-label rejection) survive in the file as a starting point.

### Bundled seed (`scripts/build-seed.py`)

- **MTEB Python registry as the bulk source — zero HF API calls for the bulk path.** The previous Node script (`build-seed.mjs`) cloned `embeddings-benchmark/results`, walked each `model_meta.json`, and fired ~5,500 HF API calls per release run — a full ~700-candidate pass burned through anonymous (500/5min) and free-tier (1,000/5min) HF rate limits and tripped 429s mid-run. The Python rewrite replaces the bulk path with `mteb.get_model_metas()` (the in-process ModelMeta registry the MTEB maintainers curate by hand) and pulls the three load-bearing fields directly: `name`, `max_tokens`, and `loader_kwargs.model_prompts`. Why Python is non-optional: `bge_models.py` uses literal `"query"` string keys in the prompts dict but `e5_models.py` uses `PromptType.query.value` enum-attribute keys (both resolve to the runtime string `"query"` because `PromptType` is a str-enum), and some family files build the dict via conditional code pure-JS regex can't follow — importing the registry resolves all forms uniformly. `npm run build:seed` is preserved as a one-line wrapper around `python3 scripts/build-seed.py`. Release CI runs `actions/setup-python@v5` + `pip install 'mteb>=2.12,<3'` + `npm run build:seed` with `continue-on-error: true` — a future MTEB symbol rename never blocks a release because the committed anchor ships unchanged in that case.
- **HF `config_sentence_transformers.json` fallback for instruction-aware models** (`_fetch_hf_default_prompts`) — MTEB stores `model_prompts: None` for ~107 instruction-aware models (Qwen3-Embedding family, e5-mistral-7b-instruct, Snowflake/snowflake-arctic-embed-l, etc.) because its evaluation harness applies task-specific instructions per benchmark via wrapper classes, not a static dict. Pre-fix the seed shipped null/null prefixes for all of them, dropping retrieval quality 1-5%. Build-seed now falls back to the model's `config_sentence_transformers.json` on HF (single GET per model, polite, well under any rate limit) and ships the author's recommended general-purpose retrieval default. Verified live: ~57% of the 107 candidates have a usable `prompts.query` field — 61 entries gain real prompts, ~46 stay null (correctly — those models have no canonical default and users override per-vault if they need one). Authentication-required models (`google/embeddinggemma-300m`, `Alibaba-NLP/gte-Qwen1.5-7B-instruct`, `nvidia/NV-Embed-v1`) return HTTP 401 and stay null. Picks `prompts.query` if present; falls back to the first `*_query` key alphabetically (deterministic) for e5-mistral-style task-specific configs.
- **Smarter `{text}` placeholder semantics + runtime `replaceAll`** (`_normalize_prompt_template` + `src/embeddings/embedder.ts` + `src/embeddings/ollama.ts`) — pre-fix the build-time normalizer stripped trailing `{text}` placeholders from prompts, but `WhereIsAI/UAE-Large-V1` shipped `"Represent this sentence for searching relevant passages: {text}"` verbatim because the runtime path used `.replace('{text}', text)` (single replacement only) and the normalizer never fired on multi-`{text}` patterns. Three buckets now: zero placeholders → ship as plain prefix; every placeholder is `{text}` → ship as template, runtime substitutes every occurrence (`replaceAll('{text}', input)` covers `"Task: {text}\nQuery: {text}"` style multi-`{text}` templates); any non-`{text}` placeholder (`{task}`, `{instruction}`, `{query}`) → drop with a warning, those vars are MTEB eval-harness conditional fills that can't be statically resolved. Regression guard added to the Python test suite walks the committed seed and asserts no non-`{text}` placeholder slips through.
- **Seed schema bumped v1 → v2** to match the new minimal-shape source. Drops `dim` / `prefixSource` / `modelType` / `baseModel` / `hasDenseLayer` / `hasNormalize` / `sizeBytes` / `runnableViaTransformersJs` (all display-only — runtime probes `dim` from the loaded ONNX, and verified during the rewrite that MTEB's curated `embed_dim=512` for `BAAI/bge-small-en-v1.5` is wrong; actual model dim is 384). Schema v2 carries only the three load-bearing fields (`maxTokens`, `queryPrefix`, `documentPrefix`). `seed-loader.ts` reads both v1 and v2 transparently via an exported `_adaptV1Entry` projection so an older anchor pulled in via cherry-pick keeps working; the adapter has direct unit-test coverage so the back-compat branch is genuinely covered, not aspirational.
- **End-to-end smoke**: local run with mteb 2.12.30 produces a **349-entry seed** (341 from MTEB filter + 8 hand-aliased Ollama tags / Xenova mirrors) in ~25 seconds, zero HF calls for the bulk path, ~107 single-model GETs for the instruction-aware HF fallback. All six canonical presets resolve with correct prefixes (BGE: `"Represent this sentence for searching relevant passages: "` query / empty document; E5: `"query: "` / `"passage: "`; Qwen3: `"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"` query / empty document).

### Hardcoded-knowledge deletions (the cleanup the layered resolver makes possible)

- **`getTransformersPrefix` if/else chain DELETED** — its 9 family-pattern branches (BGE / E5 / Nomic / mxbai / mdbr-leaf / Arctic v1+v2 / Jina v2 / GTE / Qwen3) are now sourced from `config_sentence_transformers.json` upstream. `embedder.embed()` reads `this._metadata.queryPrefix` / `documentPrefix` after `bootstrap()` calls `embedder.setMetadata(meta)` with the resolved metadata.
- **`KNOWN_MAX_TOKENS` map DELETED** — its 13 hand-curated entries are now in the bundled seed (or fetched live for BYOM). The `resolveTransformersAdvertised` helper drops the override-table check; tokenizer-config fallback path remains for tests that call `getCapacity()` directly.
- **`EMBEDDING_PRESETS[*].dim / .symmetric / .sizeMb / .lang` fields REMOVED** — preset entries are now `{ model, provider }` only. `models list` reads `maxTokens` and `symmetric` from the bundled seed at runtime; `dim` is no longer displayed (probed at runtime from the loaded ONNX, not stored in seed v2); `sizeMb` is available via `models check <id>` (live HF probe).
- **`Embedder` interface gains optional `setMetadata(meta)` / `getMetadata()`** — both `TransformersEmbedder` and `OllamaEmbedder` implement them (Ollama's wiring is below). `bootstrap.computePrefixStrategy` reads the prefix off `embedder.getMetadata()` instead of calling the deleted `getTransformersPrefix`.

### `multilingual-ollama` preset model swap

- **`multilingual-ollama` preset model swap: `bge-m3` → `qwen3-embedding:0.6b`** (`src/embeddings/presets.ts`). +4.77pp MTEB-multilingual gain (64.33 vs 59.56), 4× context window (32 768 vs 8192 tokens), smaller Ollama disk footprint (~600 MB vs 1.2 GB), instruction-aware retrieval via the canonical query prompt shipped in the seed (`"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"`). Existing `multilingual-ollama` users get a one-time auto-reindex on next boot via the existing model-id-change detection path in `bootstrap.ts` (model identifier flips from `ollama:bge-m3` to `ollama:qwen3-embedding:0.6b`); the user runs `ollama pull qwen3-embedding:0.6b` once before restart, otherwise boot fails with the existing `pull this` message. `bge-m3` remains a fully-supported BYOM target via `EMBEDDING_PROVIDER=ollama EMBEDDING_MODEL=bge-m3`. Verified live against Ollama: dim=1024, ctx=32768, digest=`ac6da0dfba84a81f...`. The known-bug stderr warning emitted on `multilingual-quality` resolution updated to recommend the new default with the new comparison numbers.

### Ollama runtime — auto-detect tag swaps, real capacity from `/api/show`, override flow-through

- **Auto-detect `ollama pull` weight swaps + extract real dim/max-tokens from `/api/show`** (`src/embeddings/ollama.ts`). Verified live against four pulled models (nomic-embed-text, all-minilm, mxbai-embed-large, qwen3-embedding:0.6b for the canonical `multilingual-ollama` preset). New `OllamaEmbedder.identityHash()` returns the manifest digest from `/api/tags` (sha256 of the model manifest); `bootstrap.ts` compares stored vs current and triggers reindex when weights swap silently under the same tag (`ollama pull bge-m3` updating `bge-m3:latest`). Init also reads `model_info.<arch>.embedding_length` (real dim) and `model_info.<arch>.context_length` (real max-tokens) from `/api/show`, so we no longer need the legacy "fire an empty embed to probe dim" path on modern Ollama. Capability check (`capabilities: ['embedding']`) fails fast with a clear error if a user accidentally points `EMBEDDING_MODEL` at an LLM. The `num_ctx` we send to `/api/embeddings` is now resolved as `OLLAMA_NUM_CTX || cachedContextLength || 8192` — the legacy `8192` default was over the architectural limit for nomic-embed-text (2048) and the bert family (512), causing Ollama to allocate context that exceeded the model's positional embedding cap.
- **Prefix overrides (`models override` / `models add`) now flow through correctly** — `OllamaEmbedder` now implements `setMetadata` / `getMetadata`. Pre-fix, the embedder used hardcoded family heuristics (`if model.includes('nomic')...`) that ignored the resolver's authoritative prefix; user overrides silently had no effect for Ollama models. Verified empirically with a real-Ollama probe: without override, nomic-embed-text query produces vector `-0.4731 0.4855 -4.6607...`; with `models override … --query-prefix "CUSTOM_QUERY: "`, the same input produces `-0.1615 0.1846 -4.6093...` — different, override is taking effect. The hardcoded heuristics remain as a fallback for the init-time probe (before `setMetadata` runs) and tests, so canonical preset behaviour is unchanged. Triple-confirmed Ollama does NOT auto-apply prefixes itself: `/api/show` template is verbatim pass-through (Go-template `{{ "{{" }} .Prompt {{ "}}" }}`) for both nomic and mxbai models; the official Ollama API docs specify no `task_type` parameter on `/api/embed` or `/api/embeddings`; an empirical "vector with vs without prefix" test confirmed prompts modify output.
- **Bootstrap prefix-strategy reindex now fires for Ollama too** (`src/pipeline/bootstrap.ts`) — pre-fix the `computePrefixStrategy` helper short-circuited to `''` for non-transformers providers, so prefix changes (override / fetch-seed / Tier 3 update) wouldn't auto-reindex Ollama users. Lifted that bypass now that Ollama actually reads metadata. Existing Ollama users on asymmetric models (nomic-embed-text, qwen, mxbai families) get a one-time reindex on next boot — same one-time-tracking-stamp pattern transformers.js users got when prefix-strategy was first added; symmetric Ollama models (bge-m3, all-minilm) are unaffected.

### CLI subcommands & UX

- **`obsidian-brain models add <id>`** — peer to `models override`, dedicated to "register a new model NOT in the bundled seed." Requires `--max-tokens N`; `--query-prefix` and `--document-prefix` default to `""`. **Refuses if the id is already in the seed** (points the user at `models override` instead). **Refuses if the id already has an override** (points at `models override <id> --remove` to clear first). No silent overwrites. When all three load-bearing fields are present, the resolver short-circuits the HF lookup entirely on first use — your override IS the metadata, no HF round-trip.
- **`obsidian-brain models override <id>`** — set, remove, or list per-model metadata overrides. Three modes: `--max-tokens N --query-prefix S --document-prefix S` (set/patch — flags combinable), `--remove [--field name]` (clear all or one field), `--list` (dump every override on disk). Each override is a partial patch — omitted fields fall through to the next layer. Use case: MTEB's curated `embed_dim=512` for `BAAI/bge-small-en-v1.5` is wrong (actual is 384) — a user wanting to correct a similar bug locally now runs `models override <id> --max-tokens <correct>` and the change persists across `npm update`. Validation rejects non-positive `maxTokens` and non-string non-null prefixes per-field; bad fields drop, good fields keep.
- **`obsidian-brain models fetch-seed`** — download the latest `data/seed-models.json` from the `main` branch on GitHub and write it to `~/.config/obsidian-brain/seed-models.json`. The seed-loader checks the user-fetched path **before** the bundled npm-tarball copy, so users get upstream MTEB fixes without waiting for an npm release. `--check` validates the download without writing. `--url <url>` overrides the source for forks / self-hosted mirrors. Schema-version-aware — refuses to overwrite if the fetched file declares an unsupported `$schemaVersion` (forces a package upgrade for runtime-affecting schema changes). Atomic write (`tmp` + rename) so partial downloads can never leave a corrupt seed.
- **`models check <id>` no longer downloads weights** — fetches metadata via Layer 1 in <2s instead of the prior ~30s download-and-load. Add `--load` for end-to-end validation.
- **`models list` surfaces every seed entry, not just the 6 presets** — added `--all` (include every entry in the bundled MTEB-derived seed; 349 dense, text-only, open-weights models as of mteb 2.12.30) and `--filter <substr>` (case-insensitive substring match on model id) flags. Combinable: `models list --all --filter mongodb` returns both `MongoDB/mdbr-leaf-ir` (preset: `english-fast`) and `MongoDB/mdbr-leaf-mt` (preset: `null`). Output adds a `preset` field that's `null` for non-preset entries; TTY footer shows "(N models matching <q> — pass --all for every seed entry)" so the gap is obvious. Closes the discoverability gap where the seed shipped invisible to users.
- **`models refresh-cache` no longer requires `VAULT_PATH`** — it only reads/writes the local SQLite DB at `$XDG_DATA_HOME/obsidian-brain/kg.db` (or `$DATA_DIR`), which is derivable without a vault. Pre-fix, running `models refresh-cache` in a clean shell threw a `UserError: VAULT_PATH is not set` even though the operation has zero dependency on vault content. Fix: new `resolveDataConfig()` helper alongside `resolveConfig()` that returns just `{ dataDir, dbPath }` and is used by every vault-agnostic CLI subcommand. Caught by the CLI audit pass.
- **`models refresh-cache` description tightened** — was missing two real-world facts. Added: (1) for seeded models the cost is ~0 HF calls (the 349-entry seed repopulates the cache instantly on next boot); 1 HF call per non-seeded BYOM id. (2) the prefix-strategy hash auto-detects any prefix change and triggers a re-embed in bootstrap, so it's safe to run any time. Caveat: if you run it OFFLINE on a non-seeded BYOM id, fallback safe defaults get cached — fix by running again online.
- **Friendly CLI errors** — new `UserError` sentinel class (`src/errors.ts`) and a CLI catch-handler split. Expected user-facing problems (missing env var, bad flag value) print `obsidian-brain: <message>\n  ↳ <hint>\n` to stderr, no stack trace. Internal/programmer errors keep printing the full stack so bugs remain debuggable. Pre-fix, `obsidian-brain watch` without `VAULT_PATH` set dumped a 10-line Commander stack trace; now: a single sentence + a one-line hint with the exact env var to set. `resolveConfig` is the first call site; future user-facing errors should throw `UserError` rather than plain `Error`.
- **`obsidian-brain --version` now reports the actual installed version** — was hardcoded at `'1.2.2'` in `src/cli/index.ts` since the project's start, drifted across every release v1.3.0 → v1.7.4. Fixed: read `version` from `package.json` at runtime via `createRequire`. Same fix also switches the short-flag from `-V` (Commander's capital default) to `-v` (the lowercase convention every modern CLI uses — `node -v`, `npm -v`, `tsc -v`). `--version` and `-h` / `--help` continue to work.
- **CLI help-text accuracy pass** — three lies fixed: (1) `obsidian-brain index --drop` description claimed it was "required when switching EMBEDDING_MODEL" — false (bootstrap auto-detects model/provider changes and wipes state on its own); now says "mostly an escape hatch". (2) `obsidian-brain search` only listed `semantic | fulltext` modes despite `ctx.search.hybrid()` being the production default — `--mode hybrid` (RRF-fused) is now the default and listed first; explicit unknown-mode rejection added. (3) `obsidian-brain models prefetch` declared a `--timeout <ms>` option that was `void`-ed in the action (option existed, did nothing, lied to users about what it did) — option removed; `prefetchModel` has its own retry+backoff loop. Verified by walking every subcommand's `--help` and cross-referencing source.
- **CLI help-snapshot tests** (`test/cli/help-snapshot.test.ts`) — captures `--help` output for the top-level program plus every subcommand and asserts via `toMatchInlineSnapshot`. **What this catches**: future drift between code and help text (developer adds a flag, removes one, changes a default, rewords a description, adds a subcommand → snapshot diff is visible in their PR). **What it does NOT catch**: lies that have always been lies — pre-fix this would have happily snapshot-locked the wrong "--drop is required when switching EMBEDDING_MODEL" claim. The snapshot is a forcing function for change-noise, not a correctness oracle. Required a small refactor of `src/cli/index.ts` to export `buildProgram()` (the script entry-point at the bottom is now gated behind a `process.argv[1] === fileURLToPath(import.meta.url)` check so importing from a test never accidentally fires `parseAsync`).

### Docs & maintainer process

- **New `docs/cli.md` page — first centralised CLI reference** covering every subcommand under `obsidian-brain` (`server`, `index`, `watch`, `search`, all `models` subcommands). Wired into `mkdocs.yml` nav as its own top-level "CLI" section. Includes new sections for `models add`, `models override`, and `models fetch-seed`; an env-var quick-reference table for `obsidian-brain server` (transformers / Ollama-preset / Ollama-BYOM / non-default Ollama-URL combinations); explicit documentation that there are three independent ways to use Ollama (preset / `EMBEDDING_PROVIDER` override / both); and the "How model metadata is resolved" section showing the 6-step chain (Layer 0 = user overrides).
- **`docs/models.md` drift fixed** — three audit-flagged issues: (1) `english` preset prefix description wrong (said `query:`/`passage:` E5-style; actual seed has BGE's `Represent this sentence for searching relevant passages: ` / `""`). (2) Seed coverage wrong (said "~250"; actual is 349 since the Python rewrite). (3) `models check` description wrong (said it goes through "the same resolution chain the runtime uses"; actually it skips the chain and goes direct to live HF — verified via the CLI audit). Plus added the new `models add` / `models override` / `models fetch-seed` rows to the subcommand table.
- **Pruned legacy preset aliases from docs prose** — `fastest` and `balanced` aliases (and accompanying "deprecation warning" sections) removed from `docs/architecture.md`, `docs/getting-started.md`, `docs/install-clients.md`, and `docs/models.md`. The aliases still resolve at runtime (one-time stderr nudge points users at the canonical name) but they're no longer surfaced in user-facing docs as supported configuration.
- **Maintainer rule added to `RELEASING.md`: no obsidian-brain self-version refs in docs prose** (everywhere except `docs/CHANGELOG.md` and `docs/roadmap.md`). Phrases like "since v1.4.0" / "added in v1.7.0" / "v1.7.5+ metadata cache" rot the moment a feature ships further back than the doc remembers — describe behaviour in the present tense instead. External dependency contracts (`plugin v0.2.0+`, `Obsidian ≥ 1.10.0`, `Node ≥ 20`) stay because they ARE the contract. Includes a one-line grep recipe maintainers can run before promote. The doc-scrub commit (`a84abc5`) was the first pass implementing this rule across ~40 references in 11 doc files; the rule itself prevents regression.
- **Stripped internal version refs from CLI surface + help-snapshot test names** — `obsidian-brain models refresh-cache --help` no longer carries `v1.7.5` in its description, and the help-snapshot test names use generic `regression:` prefixes instead of `v1.7.5 fix:`. Matches the doc-prose rule that user-facing surfaces describe behaviour in the present tense.
- **`RELEASING.md` gains four maintainer rules** — preflight description updated to include `check-env-vars` + `test:python` (was missing); new manual rule "if you touched any CLI subcommand or flag, update `docs/cli.md`" (the help-snapshot test catches the mechanical drift but not the prose); new manual rule "new env-var read in `src/` → declare in `server.json` AND keep `check-env-vars.mjs` ALLOWLIST in sync"; the `promote` step description now lists every preflight step (was abbreviated).

### Tests + observability

- **Tests substantially expanded across the release**, all under one count by end of work. Vitest additions: 4 new test files for the resolver layers (Layer 1-4) with mocked fetch + in-memory DB (~35 cases); 14 cases for the user-config layer (`test/embeddings/overrides.test.ts` — round-trip, partial merge, single-field remove, validation rejecting bad shapes, unsupported `$version` ignored); 5 cases in `metadata-resolver.test.ts` covering the override layering on each chain step; 5 cases for `models add` (set, defaults, refuses-seeded, refuses-existing-override, rejects non-positive max-tokens); 2 for the resolver Step-0 short-circuit (complete override skips HF; partial override still hits it); 5 for the `UserError` formatter; 2 covering the v1→v2 seed adapter (`_adaptV1Entry`); plus a regression-pin inline-snapshot test on the `models list` JSON output that locks the exact six-preset table (`preset` / `model` / `provider` / `maxTokens` / `symmetric`) so any future drift — preset rename, MTEB-side max-tokens shift, new preset added — fails the snapshot and forces explicit acknowledgement in the PR. **Plus three doc-drift invariant tests** (`test/docs/`): `tool-count-invariant.test.ts` asserts `docs/tools.md` heading set matches `src/tools/*.ts` exactly (catches added/removed tools that didn't propagate to docs); `no-version-refs.test.ts` rejects "since/in/as of vX.Y.Z" prose anywhere outside `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/migration-aaronsb.md` (elevates the RELEASING.md grep recipe to a CI gate); `plugin-compat-invariant.test.ts` rejects hardcoded companion-plugin version pins like "plugin v1.4.0+" (the contract is same major.minor; pins rot every release). **Plus a separate Python unit-test suite** for `scripts/build-seed.py` (`test/scripts/test_build_seed.py`, 38 stdlib-`unittest` cases): filter rules (open-weights / dense / modality / multi-vector / static-embedding-by-`inf`); prompt-extraction edge cases (bge-style literal `"query"` keys, e5-style `PromptType.query.value` enum keys, `"passage"` fallback, symmetric-model null-prefix path, max_tokens int coercion + skip reasons, defensive non-string prompt-value rejection); the alias-table covers-every-canonical-preset invariant; the new placeholder-semantics rule (zero / all-`{text}` / mixed cases including the `"Task: {text}\nQuery: {text}"` multi-template pattern); the HF fallback (`_fetch_hf_default_prompts` mocked: clean `prompts.query`, alphabetical `*_query` fallback, 404, invalid JSON, in-process cache hit); the instruction-aware-only fallback gating in `extract_entry`; the regression guard that walks the committed seed and asserts no non-`{text}` placeholder ships; and CHANGELOG/seed consistency invariants (the topmost release block's claimed seed entry count + Python test count must match reality). Runs in 0.2s with stdlib only, no `mteb` import needed. Wired into `npm run preflight` and `.github/workflows/ci.yml` so a regression in the seed generator or doc state fails CI on every PR. Final totals at end of v1.7.5 work: **885/885 vitest, 38/38 Python**, preflight 10/10 green.
- **Test output silenced** (`test/setup/silence-stderr.ts`) — vitest setup file monkey-patches `process.stderr.write` and `console.{log,warn,error}` to no-ops at module load so `npm run test:coverage` output is clean. Pre-fix: ~50 noisy lines per run from production code paths the suite intentionally exercises (per-chunk skip warnings, fault-tolerant indexer summaries, prefetch retry logs, embedder-drift drift-floor lines, background-reindex catch handlers, metadata-resolver HF-fallback warnings). Tests that capture stderr via `vi.spyOn(process.stderr, 'write')` keep working — their spy wraps the no-op and replaces its impl with their capture for the test's duration. Direct property assignment (NOT `vi.spyOn`) so the silencer survives `vi.restoreAllMocks()` and catches stderr from async fire-and-forget catch handlers that fire after `afterEach` has run. Override: `OBSIDIAN_BRAIN_TEST_STDERR=1` to skip the silencer when debugging.

## v1.7.4 — 2026-04-25 — `english-fast` preset model swap → MongoDB/mdbr-leaf-ir

**One-time auto-reindex on upgrade for users on `EMBEDDING_PRESET=english-fast` or the deprecated `fastest` alias.** No action required — semantic search returns `{status: "preparing"}` during the rebuild; everything else stays online. Other presets unaffected.

- **`english-fast` model swap** — `Xenova/paraphrase-MiniLM-L3-v2` (17 MB, 384d, symmetric, MTEB ~0.55) → `MongoDB/mdbr-leaf-ir` (22 MB, 768d post-Dense projection, asymmetric, retrieval-tuned). mdbr-leaf-ir is a 23M-param Matryoshka student of `mxbai-embed-large-v1`, distilled and retrieval-tuned by MongoDB. Apache-2.0. Ships ONNX weights in the official HF repo so transformers.js v4 loads it directly without an `onnx-community/...` mirror. Sister model `MongoDB/mdbr-leaf-mt` is for general/clustering tasks; `-ir` is what we wire here for RAG-style search.
- **Mxbai-style asymmetric prefix** — `getTransformersPrefix` now matches `mdbr-leaf` alongside `mxbai` / `mixedbread`, applying `Represent this sentence for searching relevant passages: ` to queries and an empty prefix to documents (per the `config_sentence_transformers.json` shipped on the model). Users don't need to do anything — same auto-prefix flow as bge / e5 / nomic / arctic.
- **`KNOWN_MAX_TOKENS`** — adds `MongoDB/mdbr-leaf-ir` and `MongoDB/mdbr-leaf-mt` at 512 tokens (max_position_embeddings).
- **Deprecation message updated** — the `EMBEDDING_PRESET=fastest` warning now notes that v1.7.4 also changed the underlying model, alongside the existing rename-to-`english-fast` guidance. `EMBEDDING_PRESET=fastest` keeps working; users can switch to `english-fast` to suppress the warning, or pin `EMBEDDING_MODEL=Xenova/paraphrase-MiniLM-L3-v2` to keep the old model.
- **`docs/models.md`** — preset table + quality ranking + license catalogue updated for the swap.

## v1.7.3 — 2026-04-25 — Title-fallback for empty notes + capacity-drift floor + three-bucket index_status

**Urgent fix.** v1.7.2's "fault-tolerant + self-heal" did not actually fix the user-reported 32% missing-embeddings symptom. After a v1.7.2 reindex, vaults full of daily-note stubs / MOCs / template-only notes still showed `notesMissingEmbeddings ≈ 32%` regardless of which embedder was active (multilingual-quality, bge-m3, qllama/multilingual-e5-large-instruct — all reproduced the same number). Root cause: the chunker correctly returned `[]` for content-less notes, but `setSyncMtime` still fired, leaving them invisible to `index_status`'s JOIN. v1.7.2's F6 self-heal would wipe their `sync.mtime` on every reindex — but the next pass produced zero chunks again, infinite no-op loop. Compounded by an unfloored adaptive-capacity ratchet that drove `discovered_max_tokens` down to 115 (from 512 advertised) on long-note failures, cascading more chunks into "too long" → more shrinking → runaway. Upgrading from v1.7.2 is drop-in; the next reindex auto-rebuilds and the 32% number drops to a small honest count.

- **Title-fallback embedding for content-less notes** — `src/pipeline/indexer.ts` `embedChunks` now synthesises a single fallback chunk from `title + tags + scalar frontmatter values + first 5 wikilink/embed targets` when `chunkMarkdown()` returns `[]`. Daily notes (`# 2026-04-25` only), frontmatter-only metadata notes, embeds-only collector notes, and any note shorter than `minChunkChars` now stay searchable by name instead of being silently dropped from the index. Truly content-less files (no title, no frontmatter, no body) are recorded in `failed_chunks` with reason `'no-embeddable-content'` and skipped permanently — no infinite-retry loop.
- **Adaptive-capacity floor** — new `MIN_DISCOVERED_TOKENS = 256` floor in `src/embeddings/capacity.ts` clamps `reduceDiscoveredMaxTokens` so a single freak chunk failure can no longer halve the cached budget down into single-sentence territory. For tiny models (advertised < 256) the floor adapts to `min(MIN_DISCOVERED_TOKENS, advertised)` so we never claim more capacity than the model supports.
- **Capacity reset on every full reindex** — new `resetDiscoveredCapacity(db, embedder)` is called at the top of `IndexPipeline.index()` to wipe `discovered_max_tokens` back to advertised. Closes the cross-boot drift cascade where yesterday's runaway shrunken value would still throttle today's pass even after the underlying issue is gone.
- **F6 self-heal becomes a true diagnostic, not a retry-loop** — the end-of-reindex query now JOINs `chunks_vec` (catches notes whose chunk rows exist but failed to embed) and excludes notes already classified as `'no-embeddable-content'` (those will fail the same way next pass; wiping their `sync.mtime` is the v1.7.2 infinite-loop bug). Notes with genuine unexpected gaps (e.g., dead embedder mid-pass) still get retried on next boot.
- **`index_status` reports three buckets** — adds `notesNoEmbeddableContent` (count of distinct `note_id`s in `failed_chunks` with reason `'no-embeddable-content'`) alongside the existing `notesWithEmbeddings`. `notesMissingEmbeddings` is redefined as `notesTotal - notesWithEmbeddings - notesNoEmbeddableContent` so it reflects only genuine failures, not the daily-note tail. New `summary` field gives MCP clients a one-line human-readable description so Claude reports "X / Y indexed; Z have no embeddable content; W failed" instead of conflating all three into a single misleading "missing" count.

## v1.7.2 — 2026-04-25 — Reindex bug fixes + multilingual-ollama auto-routing + docs split

**Urgent fix.** Upgrading from v1.7.0 / v1.7.1 is drop-in. If your last reindex left notes without embeddings, the next boot's end-of-reindex self-heal queues them for retry automatically.

- **Fix `reindex` throwing `"Too few parameter values were provided"`** — `src/store/nodes.ts` `upsertNode` now coerces undefined `title` / `content` / `frontmatter` to safe defaults before the `.run()` call (handles malformed frontmatter, NULL rows from older obsidian-brain versions, etc.). On any remaining `RangeError` / `Cannot bind` SQLite-bind error, the wrapper re-throws with the failing node id, the field types, and `rm -rf ~/.npm/_npx` recovery guidance — instead of the cryptic raw SQLite wording.
- **Fix silent 33% note-skip after switching `EMBEDDING_PROVIDER`** — `src/pipeline/indexer.ts` `applyNode` now wraps the legacy note-level `embedder.embed(...)` call (line ~327) in the same fault-tolerant try/catch as the per-chunk embed loop. Notes that hit transformers.js's `multilingual-e5-base` token_type_ids bug or any other "too long" / shape error now (a) get logged + recorded in `failed_chunks` as `note-too-long` / `note-embed-error`, (b) still get `setSyncMtime` so a later reindex can retry, and (c) keep their per-chunk embeddings (chunk-level retrieval still works). End-of-reindex self-heal detects any note that still has zero chunks, wipes its `sync.mtime`, and reports `notesMissingEmbeddings` via the `index_status` tool.
- **Fix `EMBEDDING_PRESET=multilingual-ollama` routing to HuggingFace 401 instead of Ollama** — preset entries now declare a `provider: 'transformers' | 'ollama'` field. New `resolveEmbeddingProvider(env)` honours `EMBEDDING_PROVIDER` override → `EMBEDDING_MODEL` (assumes transformers) → preset's declared provider. So `EMBEDDING_PRESET=multilingual-ollama` now "just works" without ALSO needing `EMBEDDING_PROVIDER=ollama` set. Unknown provider values still throw with a clear error listing valid options.
- **Defensive top-level `index()` error classifier** — SQL bind / schema-drift errors are now caught at the top of the indexer pipeline, logged with the offending statement fragment, and re-thrown with actionable guidance. MCP clients see `"reindex failed: SQL error (likely schema drift or stale install) — …"` instead of the raw `"Too few parameter values"`.
- **`dropEmbeddingState` clears v6 capacity tables** — switching `EMBEDDING_PROVIDER` (Ollama → transformers or vice versa) now wipes `embedder_capability` and `failed_chunks` alongside the existing `nodes_vec` / `chunks_vec` / `chunks` / `sync` clear. Closes the cascade where a stale shrunken `discovered_max_tokens` from a prior run would force every chunk into the skip path.
- **New `selfCheckSchema(db)`** runs in `openDb` after `initSchema`. For each v1.7.0 schema-v6 table (`embedder_capability`, `failed_chunks`), it cross-references the live column set against the code's expected list via `PRAGMA table_info`. Auto-heals fully-missing tables; warns to stderr on missing columns; warns-but-continues on extra columns (forward-compat). Catches stale-cache scenarios where an older obsidian-brain wrote a different schema than the current code reads.
- **Stderr warning when `EMBEDDING_PRESET=multilingual-quality` resolves** — surfaces the documented [transformers.js#267](https://github.com/huggingface/transformers.js/issues/267) `token_type_ids` bug for inputs > ~400 words and points users at `multilingual-ollama` (bge-m3, MTEB multi 0.7558) or `multilingual` (e5-small, more tolerant) as alternatives.
- **`docs/embeddings.md` split** — preset catalogue + BYOM + license notes moved to a new `docs/models.md` ("Models" tab in the docs nav). `docs/embeddings.md` stays lean for pipeline architecture (chunking, hybrid RRF, why local). Fixes the misleading "Highest-quality multilingual preset" label that was incorrectly applied to `multilingual-quality` (e5-base, MTEB 0.6881) — the title now correctly belongs to `multilingual-ollama` (bge-m3, MTEB 0.7558, 16× context window). Adds BYOM entries with exact `ollama pull` / `EMBEDDING_MODEL` recipes for `intfloat/multilingual-e5-large-instruct` (MIT, MTEB 0.7781), `Alibaba-NLP/gte-modernbert-base` (Apache-2.0, 8192 ctx, +8.3pp), `onnx-community/embeddinggemma-300m-ONNX` (+9.3pp), and `onnx-community/mdbr-leaf-mt-ONNX` (Apache-2.0, best sub-30M).

## v1.7.1 — 2026-04-24 — Docs sweep for v1.7.0

**No user-visible code change.** Documentation-only release. Upgrading from v1.7.0 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`docs/tools.md`** — added `index_status` tool section + capability-matrix row. The tool shipped in v1.7.0 but had no entry in the reference; now documented with all response fields (`embeddingModel`, `chunksSkippedInLastRun`, `failedChunks[]`, `advertisedMaxTokens`, `discoveredMaxTokens`, `reindexInProgress`, etc.).
- **`docs/embeddings.md`** — replaced the stale "Available models" table with the actual v1.7.0 six-preset set (`english`, `english-fast`, `english-quality`, `multilingual`, `multilingual-quality`, `multilingual-ollama`). Added a "Deprecated aliases" subsection explaining the model change for `balanced` (now `english` — re-embeds once on upgrade). Speed-numbers table rewritten to use canonical preset names.
- **`docs/roadmap.md`** — renumbered the "Planned / In progress" v1.7.0 section to v1.8.0 (block-ref editing + FTS5 frontmatter + topic-aware PageRank). v1.7.0 shipped as a completely different bundle; the version collision is now resolved. Corresponding v1.8.0 (analytics writeup) moves to v1.9.0.
- **`README.md`** — "17 MCP tools" → "18 MCP tools"; added `index_status` to the Maintenance bullet.
- **`docs/index.md`** — new "Health & observability" feature card covering fault-tolerant indexing + `index_status` / `reindex`.
- **`docs/architecture.md`** — expanded preset-resolver paragraph to v1.7.0 shape (six presets + deprecated aliases + first-boot auto-recommend); added `embedder_capability` and `failed_chunks` tables to the schema listing with their v1.7.0 rationale.

## v1.7.0 — 2026-04-24 — Fault-tolerant embeddings, expanded presets, BYOM CLI, index_status tool, one-line macOS installer

**⚠ One-time background reindex on upgrade** — v1.7.0 bumps the prefix-strategy version to close a latent Arctic Embed v2 bug and to add Ollama-routed e5 prefix support. Asymmetric-model users (BGE, E5, Nomic, etc.) will see a one-time re-embed on first boot; semantic search returns a `preparing` status during it; fulltext + all other tools work throughout.

**Fault tolerance + adaptive capacity:**
- **Fault-tolerant rebuild** — per-chunk try/catch so one bad chunk no longer halts a full reindex; skipped chunks are logged and recorded in the new `failed_chunks` table. Follows NAACL 2025 consensus: skip + log, not recurse-halve.
- **Ollama `num_ctx` override** — new `options.num_ctx` field in every embed request (default 8192); configurable via `OLLAMA_NUM_CTX`. Ollama's own default of 2048 silently truncates long chunks for models trained on larger contexts.
- **Adaptive capacity** — tokenizer-aware chunk budgeting reads `model_max_length` directly from the model's AutoTokenizer; schema v6 adds `embedder_capability` and `failed_chunks` tables; failed chunks reduce the cached `discovered_max_tokens` so future chunks aim smaller. Configurable via `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS`.
- **`EmbedderLoadError`** — structured error with `kind`: `not-found` (model id not on HF), `no-onnx` (repo exists, no ONNX weights), `offline` (network unavailable at load time). Wraps around the existing corrupt-cache retry logic.

**Preset + BYOM UX:**
- **6 presets** (was 4): `english`, `english-fast`, `english-quality`, `english-longctx`, `multilingual`, `multilingual-quality`. Deprecated aliases `fastest` and `balanced` emit a stderr warning and resolve to their canonical equivalents.
- **`balanced` model change** — `balanced` now resolves to `english` (`bge-small-en-v1.5`). The old model (`all-MiniLM-L6-v2`) is dropped. **If you use `EMBEDDING_PRESET=balanced` you will re-embed once on upgrade.** Change to `EMBEDDING_PRESET=english` to suppress the deprecation warning going forward.
- **First-boot auto-recommend** — scans vault Unicode blocks on first start and recommends `english` vs `multilingual` preset automatically.
- **New `obsidian-brain models` CLI** — `list`, `recommend`, `prefetch`, and `check <id>` subcommands. `check` downloads, loads, and reports dim + prefix behaviour before you commit to a model.

**Prefix fixes:**
- Arctic Embed v2 now emits `query: ` prefix (v1 used the longer "Represent…" instruction — now corrected).
- Ollama-routed E5 models now receive `query:` / `passage:` prefixes (previously silently dropped, causing a 20–30% quality regression).
- Qwen3 embeddings now receive `Query: ` on the query side.
- Jina v2 and GTE registered as explicit no-ops (no false fallthrough).
- `PREFIX_STRATEGY_VERSION` bumped 1 → 2 — triggers the one-time reindex described above.

**Observability:**
- **New `index_status` MCP tool** — read-only: reports active model, dim, notes indexed, failed chunks, capacity bounds, whether a reindex is in flight, and any init errors. Call it from your MCP client to inspect index health at any time.
- `ctx.reindexInProgress` is now a reliable boolean (previously an unreliable promise probe).
- Semantic `search` returns a `preparing` status with a reindex-in-progress message when the bootstrap `needsReindex` flag fires.

**Quality:**
- **TreeRAG parent-heading prefix** — each chunk embedding is prefixed with its nearest parent heading path (ACL 2025), improving multi-chunk relevance for long notes.
- **v4.2.0 numerical equivalence retro-check** — 50-note fixture verifies cosine similarity ≥ 0.99 per note against the v4 baseline after the `@huggingface/transformers` 3 → 4 upgrade. Threshold chosen to tolerate cross-platform `onnxruntime-node` SIMD / GEMM accumulation drift (Linux AVX ↔ macOS NEON produce 0.997–0.999 cosine on quantized q8 inference — inherent float-math divergence, not a library regression) while still catching every real regression worth catching (tokenizer break, pooling shift, weight corruption, sign flip, wrong model — all drop well below 0.95). An `afterAll` drift-floor warning prints the minimum cosine per run with runtime + baseline platforms tagged, so maintainers can spot downward trends before they red-line. Baseline JSON records `platform`, `arch`, and `onnxruntime-node` version for future debug.
- Schema v6 migration is idempotent; existing databases upgrade in-place.

**CLI + retry polish:**
- `prefetchModel` default `maxAttempts` lowered from 4 to 3. `obsidian-brain models prefetch` and `models check` now fail faster on unreachable / missing models — three attempts is the industry-standard retry budget and matches the HF CLI. Explicit overrides can still pass `maxAttempts` via the option.
- New `test/embeddings/prefetch-integration.test.ts` — actually downloads and probes `Xenova/bge-small-en-v1.5` via the real `@huggingface/transformers`, and verifies the retry loop rejects with `attempts = N` when a real HF model id doesn't exist. Previously the mock-based unit tests injected fake error strings but no real model load was ever exercised. Runs by default; opt out with `OBSIDIAN_BRAIN_SKIP_BASELINE=1` (same flag as `v4-equivalence.test.ts`, which shares the HF cache).

**One-line macOS installer:**
- **`scripts/install.sh`** — a Homebrew-style curl-piped bash installer that automates every step of `docs/install-mac-nontechnical.md`: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/sweir1/obsidian-brain/main/scripts/install.sh)"`. Installs Homebrew non-interactively if missing, installs or upgrades Node to ≥ 20.19.0, symlinks `node` + `npx` into `/usr/local/bin` so GUI-launched Claude Desktop can resolve them (the recurring `spawn npx ENOENT` failure mode), prompts for the vault path with auto-detection of `~/Documents/Obsidian Vault`, `~/Documents/Obsidian`, and iCloud `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/*`, pre-warms the npx cache so any `ERR_DLOPEN_FAILED` from a mismatched `better-sqlite3` ABI surfaces before Claude Desktop ever spawns (with the exact `rm -rf ~/.npm/_npx` remediation printed inline), and politely `osascript` quits + relaunches Claude so the new Full Disk Access grant takes effect on next launch.
- **Non-destructive config merge.** A small `node` one-liner JSON-merges the obsidian-brain entry into `~/Library/Application Support/Claude/claude_desktop_config.json`, preserving every other `mcpServers` entry and every top-level key. A timestamped `.bak.<epoch>` of the pre-merge file is written on every run — even when the existing config is malformed JSON, the original is preserved and a fresh config is written. Re-running is idempotent (returns `replaced` instead of `added` when the entry already exists). Node was chosen over `jq` (not installed on stock macOS) and `python3` (deprecated on stock macOS) because the installer just installed Node for the user as a hard prerequisite.
- **Full Disk Access via deep-link, not automation.** The pane is opened with the Ventura+ URL `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` and falls back to the legacy `com.apple.preference.security` URL for older macOS. The installer then blocks on an Enter press rather than polling — the TCC grant lives in `/Library/Application Support/com.apple.TCC/TCC.db` which is SIP-protected at the kernel level, `tccutil` only exposes `reset` (never `grant`), and the only supported silent path is an MDM-delivered PPPC profile.
- `README.md`, `docs/index.md`, `docs/install-mac-nontechnical.md` — updated to surface the one-liner above the existing manual JSON snippet. The manual walkthrough stays intact as the auditable reference the script mirrors step-for-step.
- `package.json` — `scripts/install.sh` added to the `files` array so the installer ships in the npm tarball alongside `dist/`.

**New env vars** (declared in `server.json` per v1.6.21 validator):
- `OLLAMA_NUM_CTX` — override Ollama's context window for embed requests (default 8192).
- `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS` — override the adaptive chunk-size budget in tokens.

## v1.6.22 — 2026-04-24 — Split coverage discipline into its own doc

**No user-visible change.** Documentation-only release. Upgrading from v1.6.21 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`docs` — extract coverage discipline from `RELEASING.md` into `docs/coverage.md`.** `RELEASING.md` had grown to 811 lines, with ~217 lines of coverage-gate essay (gate shape, V8 provider rationale, `/* v8 ignore */` policy, fast-check pilot, grandfather mechanism, two discipline principles, manual ratchet, escape hatch) buried mid-doc. The coverage content moves to its own standalone mkdocs page — `docs/coverage.md`, linked from the site nav under Project → Test coverage. `RELEASING.md` keeps a short gate-summary section naming the three enforcement checkpoints (preflight, CI, release gate) and explicitly directing the reader to `docs/coverage.md` as required reading before a first release.
- **`docs` — trim branch-protection essay from `RELEASING.md`.** Three subsections were restating what the ruleset definitions already made explicit: "Defense in depth — why these give you what you asked for" (prose restating the rule list above it), "Emergency escape hatch" (a `gh api` recipe findable in 5s via web search), and "If CI breaks (temporary)" (an edge-case flag for `setup:protection`). All three deleted. The ruleset-by-ruleset breakdown (main hard / main workflow / dev) stays — that's the actual operational info.
- **Net**: `RELEASING.md` 811 → 603 lines. Coverage content reachable as its own doc. mkdocs strict build green.

## v1.6.21 — 2026-04-24 — Validate server.json before publish; drop dist-tag auto-roll

**No user-visible change.** Release-plumbing release. Upgrading from v1.6.20 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`ci(release)` — move `server.json` validation before `npm publish`.** The previous ordering ran `./mcp-publisher validate` AFTER npm already had the tarball, so a malformed `server.json` (e.g. drift in the hand-maintained `environmentVariables[]` list) would leak an un-publishable-to-MCP-Registry version onto npm. Now validation runs immediately after build, before either publish — if `server.json` fails the schema, nothing ships. Matches the pre-existing npm `preversion` hook pattern (check first, mutate second).
- **`ci(release)` — drop the `previous` dist-tag auto-roll.** v1.6.20's release.yml added two steps that tried to capture the pre-publish `latest` and set `previous` to it after publish. The post-publish step failed with E401 on every release, because **npm's OIDC trusted publisher token is scoped to `publish` only** — it can't authenticate `npm dist-tag add`. Worse, the failure cascaded (default GitHub Actions skips subsequent steps) and took MCP Registry + GitHub Release down with it on v1.6.20. Dropping the feature entirely: keeping OIDC-only auth (no long-lived `NPM_TOKEN` secret) means `previous` is maintained manually when it matters: `npm dist-tag add obsidian-brain@X.Y.Z previous`.
- **`ci(release)` — reorder install-mcp-publisher earlier.** mcp-publisher binary is now downloaded before npm publish so that `./mcp-publisher validate` can run on `server.json` before any publish. Login to the MCP Registry stays where it was (after npm publish, before MCP publish) — the OIDC token exchange at login time is independent of package state.

## v1.6.20 — 2026-04-24 — Auto-roll `previous` dist-tag on every publish

**No user-visible change.** Release-plumbing release. Upgrading from v1.6.19 is drop-in — no schema migration, no config change, no runtime behaviour shift.

- **`ci(release)` — roll `previous` dist-tag on every publish.** The `previous` npm dist-tag was set manually during the v1.6.16 / v1.6.17 out-of-order recovery and then stayed pinned at 1.6.17 across every subsequent release, because nothing moved it. `release.yml` now has two new steps bracketing `npm publish`: (1) captures the current `latest` before publishing (into a step output), (2) after publish rolls `previous` to that captured value. Net effect: `previous` always tracks "the version one before the current `latest`", auto-maintained. Useful as a well-defined rollback target for each release. Skips cleanly on first-ever publish or a same-version republish. Reuses the OIDC session set up for `npm publish` — no extra secret or OTP.

## v1.6.19 — 2026-04-24 — Release system hardening (B5 follow-up)

**No user-visible change.** Release-plumbing release. Upgrading from v1.6.18 is drop-in — no schema migration, no config change, no runtime behaviour shift.

Follow-up to the B5 flow that shipped in v1.6.14. Three issues surfaced during the v1.6.14 → v1.6.18 back-to-back ship and are closed here:

- **`fix(promote)` — auto-resolve CHANGELOG merge-back conflicts.** Under B5, dev carries CHANGELOG entries for yet-to-ship future releases above the one just shipped. When `promote` merges `origin/main` back into `dev`, git flags `docs/CHANGELOG.md` as conflicted — even though the correct resolution is trivially "keep dev's side" (dev has the superset). `promote.mjs` now detects the only-CHANGELOG-conflicted case and auto-runs `git checkout --ours docs/CHANGELOG.md && git add && git commit --no-edit`. Any other conflicted file still fails loudly with the same recovery hint as before. Zero manual steps per release.
- **`fix(ci)` — queue concurrent CI runs instead of cancelling.** `ci.yml` previously had `cancel-in-progress: true` with a concurrency group keyed only on the ref, so rapid-fire main pushes caused a cancel-cascade: each new commit's CI cancelled the previous commit's still-running CI. Combined with `release.yml`'s new "Wait for CI green on this SHA" gate, this blocked publishes for older commits (it's how v1.6.16 and v1.6.17 ended up tagged-on-main-but-not-on-npm, requiring a manual `--tag previous` recovery). Fix: `cancel-in-progress: false` + SHA in the group so different commits queue instead of cancel, and re-pushes of the same commit still coalesce.
- **`ci(release)` — drop smoke + HF prefetch from `release.yml`.** The new CI-gate step confirms `ci.yml` was green on the exact tagged SHA before `release.yml` proceeds. Re-running smoke / HF cache restore + save / prefetch inside the release job was pure duplication of work `ci.yml` already did on the same commit. Kept: Node setup, `npm ci`, build (those produce the tarball npm publishes — they're prep, not validation). Dropped: HF restore, prefetch, HF save, smoke. ~60–90s saved per release.
- **`chore(deps-actions)` — bump `actions/upload-artifact` 4 → 7** (coverage report upload in `ci.yml`). Drop-in for our usage — `name`, `path`, `retention-days`, `if-no-files-found` all unchanged. v6 moved the action's runtime from Node 20 → 24, which resolves the Node 20 deprecation warning GitHub was annotating on every CI run (ahead of Node 20's removal from runners in September 2026). New opt-in inputs (`archive`, `compression-level`, `overwrite`, `include-hidden-files`) all default to v4-compatible values.

## v1.6.18 — 2026-04-24 — chore: bump @huggingface/transformers 3 → 4

**No user-visible change expected.** Dependency-update release. Upgrading from v1.6.17 is drop-in for the default `english` preset in the environment where preflight ran; `fastest`/`balanced`/`multilingual` presets will re-download models on first use if ONNX file formats differ between v3 and v4.

- **`@huggingface/transformers` 3.8.1 → 4.2.0** (new C++ WebGPU runtime on ONNX Runtime; tokenizers extracted to `@huggingface/tokenizers`, jinja extracted to `@huggingface/jinja`; build moved Webpack → esbuild). Our usage in `src/embeddings/embedder.ts` — `pipeline('feature-extraction', model, { dtype: 'q8' })`, `env.cacheDir`, the custom `Extractor` interface (`tolist()`, `dispose()`) — works unmodified under v4.
- **New transitive runtime deps (auto-installed):** `@huggingface/tokenizers@^0.1.3`, `@huggingface/jinja@^0.5.6`, `sharp@^0.34.5`, `onnxruntime-node@1.24.3`, `onnxruntime-web` (dev build). No direct dev-dep addition required.
- **If reverting to v1.6.17 or earlier**, run `rm -rf $TRANSFORMERS_CACHE` before rolling back — v4 ONNX files aren't guaranteed to be readable by v3.

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
