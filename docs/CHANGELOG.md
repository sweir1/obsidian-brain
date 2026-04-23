---
title: Changelog
description: User-facing release notes. For full commit detail, see GitHub Releases.
---

# Changelog

User-facing release notes. For full commit-level detail see [GitHub Releases](https://github.com/sweir1/obsidian-brain/releases).

## v1.6.7 — 2026-04-23 — MCP init timeout fix + non-blocking write tools

**⚠ Behavior change for write tools.** `create_note`, `edit_note`, `apply_edit_preview`, `move_note`, `delete_note`, and `link_notes` now return as soon as the write completes; the subsequent reindex runs in the background instead of being awaited inside the response. A newly-written note becomes searchable within a few seconds (same window as the file watcher has always had for out-of-band edits). Agents or scripts that implicitly relied on synchronous write-then-search must either await a small delay or explicitly call `reindex` before the follow-up search.

**Init timing fix.** The MCP `initialize` handshake no longer waits for the embedding-model download. Previously, on a fresh install with slow internet, the ~34 MB model download took longer than MCP clients' (Claude Desktop, Jan, Cursor) handshake timeout, leaving users locked out with a "tools failed" message. Now `server.connect(transport)` runs immediately; the model download + first-time index proceed in parallel. Tools that don't need the embedder (`list_notes`, `read_note`, `find_connections`, `find_path_between`, `rank_notes`, all write tools, fulltext search, plugin-dependent tools) respond instantly. Semantic search returns a structured `{status:'preparing', message:…}` response during the download window — within the client timeout — instead of hanging.

If the background init fails (e.g. model not found, network error), semantic search returns `{status:'failed', message:…}` with an actionable message; restart the MCP server to retry.

- Reordered `server.connect(transport)` to run before the embedder + first-time-index pipeline
- `search({mode:'semantic' | 'hybrid'})` returns `preparing` / `failed` status immediately when the embedder isn't ready
- Six write tools fire-and-forget their post-write reindex; the `reindex: 'failed'` envelope is removed from their return types
- `fulltext` search, all read tools, graph tools, and write tools are unblocked from first-run model download
- Embedder auto-recovers from a corrupt local Hugging Face cache: on a `Protobuf parsing failed` / `Load model failed` / `Unable to get model file` error on first load, the model's cache subdirectory is wiped and re-downloaded once automatically (previously required a manual `rm -rf` of the HF cache)
- 18 new integration tests in `test/integration/server-init-timing.test.ts` drive a slow-init mock embedder end-to-end; full suite at 479/479 passing with zero stderr noise from background reindexes

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
