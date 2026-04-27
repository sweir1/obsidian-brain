---
title: Roadmap
description: Shipped releases, what's next, and what we've deliberately scoped out.
---

# Roadmap

## Recently shipped

<!-- GENERATED:recent-releases -->
{{ recent_releases(5) }}
<!-- /GENERATED:recent-releases -->

## Planned / In progress

> **Note on version numbering.** v1.7.0 shipped on 2026-04-24 as a different bundle than this page originally planned — it became the fault-tolerant-embeddings / expanded-presets / BYOM CLI / `index_status` / macOS installer release (see CHANGELOG). The block-ref editing / FTS5 frontmatter / topic-aware PageRank work below has therefore been renumbered to v1.8.0.

### v1.7.21 — remaining v1.7.x polish (~few days)

What's left from the v1.7.18 audit catalogue + small additions surfaced during v1.7.20. None require a schema change or breaking-API shift.

- **Auto `ollama pull` on missing model (opt-in).** Today users hitting `multilingual-ollama` for the first time have to run `ollama pull qwen3-embedding:0.6b` manually after seeing v1.7.19's actionable error. With `OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL=1` set, detect a 404 from `/api/show`, kick off `/api/pull` (streaming JSON-line response → progress to stderr), then re-init. Off by default — a 600 MB download without explicit consent is invasive; opt-in respects user intent.
- **V4 — optional NDJSON stderr.** Add `OBSIDIAN_BRAIN_LOG_FORMAT=ndjson` for structured log aggregators. Default stays plain-text. Mechanical refactor across ~88 call-sites in 26 files; needs a central `src/util/log.ts` helper that the existing `process.stderr.write` calls switch over to.
- **O3 / N2 — Ollama "preparing" status path.** Today the transformers.js side returns `{embedderReady: false, status: 'preparing'}` so MCP clients can poll gracefully during model load; the Ollama side throws synchronously. Needs a state machine on `OllamaEmbedder` (`not-started | probing | ready | failed`) plus poll-friendly tool semantics.
- **D3 / D4 — schema docs.** Copy the `embedder_capability` + `index_metadata` `CREATE TABLE` blocks from `src/store/db.ts:103-107` and `:133-150` into a new "Database schema" section in `docs/architecture.md`, with column-by-column annotations for users debugging "why does my preset use the wrong dim?"
- **E1 — env-var doc tightening.** Crisper `OBSIDIAN_BRAIN_NO_CATCHUP=1` semantics in `docs/configuration.md`.
- **Audit doc clarifications (C9 / R2 / C12 / G9).** Bundle as one docs item: clarify `stubNodesCreated` semantics in the `reindex` response shape (newly-materialised this run, not total in graph); clarify `stubsPruned` (orphan stubs deleted this run); document the boot-time version banner format from `src/preflight.ts:161-168`; document the `next_actions` envelope on `find_connections` in `docs/tools.md`.
- **O7 — verify Qwen3 32k context not capped.** No code change expected (verified empirically there's no hardcoded cap at `src/embeddings/capacity.ts:242`). Run a Qwen3 vault reindex and confirm `index_status.advertisedMaxTokens` is 32768 on a 10k+ vault.
- **v1.7.19 test-coverage gaps.** Three call-site / wiring gaps remain from the v1.7.19 unit suite:
    - **L1 integration test.** Extend `test/integration/server-stdin-shutdown.test.ts`: spawn the server, kick a background reindex, send SIGTERM mid-flight, capture stderr, assert no `database connection is not open` lines. Verifies `src/server.ts:178-198` actually uses the await-pattern (a typo removing the `await Promise.race(...)` would still pass every unit test).
    - **G1 `refreshCommunities` direct assertion.** Build a graph with mixed real + stub nodes, call `pipeline.refreshCommunities()`, query the `communities` table, assert no community has any `_stub/*` ID in `nodeIds`. The builder is unit-tested but `refreshCommunities`'s exact `KnowledgeGraph.fromStore(this.db)` call at `src/pipeline/indexer/index.ts:267` is verified only implicitly.
    - **C7 `rng` option is forwarded.** Spy on the louvain import in `test/graph/communities.test.ts` and assert `louvain` was called with `options.rng` set to a function. Determinism tests verify the contract; this verifies the implementation. Catches a graphology upgrade that renamed `rng` to something else.

#### Audit items explicitly accepted as-is

Listed so they're answered, not silently dropped — these are working as designed or not worth the change for the value:

- **D1 — `nodes.content` stored verbatim alongside `chunks.content`.** ~40 MB doubling on a 10k-note vault. Joining-on-read is slower than the current denormalised layout; the disk overhead is acceptable.
- **D2 — two parallel vec0 indexes (note-level + chunk-level).** Powers `unique:notes` vs `unique:chunks` search modes; both are real product features with different recall semantics. Collapsing to one would lose a feature.
- **O6 — boot-time probe of Ollama liveness.** Already addressed via `/api/show` + `/api/tags` calls inside `OllamaEmbedder.init()`. The remaining "fail-loudly-at-boot-if-daemon-down" pattern is partial because the design intentionally lets handshake complete and surfaces the error per-tool-call (so MCP transport stays alive even when Ollama isn't).
- **S3 — `discoveredMaxTokens` vs `advertisedMaxTokens` divergence.** Two-field design is intentional: advertised is from `tokenizer_config.json`, discovered is empirically tested with reserved special tokens. Documenting the difference is a v1.7.21 polish item under D3/D4.
- **S4 — no `model_info(preset)` MCP tool.** The CLI's `models check` covers this. Adding an MCP variant would duplicate without a real client need.
- **V3 — companion-plugin error message truncated.** The truncation is the harness's display logic, not the server's stderr. Server error string is fine; consumer should adapt.

### v1.8.0 — block-ref editing + FTS5 frontmatter + topic-aware PageRank (~1-2 weeks)

Pairs with plugin v1.8.0.

- **`edit_note(mode: 'patch_block', block_id: '^abc123')`.** Parse `^[a-zA-Z0-9-]+$` at line end into a new `block_refs(id, node_id, start_line, end_line)` table; boundary is text from ID back to previous blank line or previous block ID. Meaningful Obsidian-power-user gap (lstpsche ships it, we don't). Adds one tool — count becomes 19.
- **FTS5 frontmatter fielding.** Tokenize frontmatter alongside title + body as a fielded index, moderate 2× boost. Complements v1.4.0's stemming + column-weighted BM25.
- **`find_influential_notes_about(topic)`.** The tool only obsidian-brain can ship because only it co-locates both signals: semantic neighborhood → induced subgraph → PageRank on the subgraph. Replaces the noisy full-vault PageRank for topic-aware "what are the hubs here". One new tool — count becomes 20.

#### Audit items needing more than a patch

These v1.7.18-audit items need schema migrations, new tools, or a multi-tool refactor — not appropriate for v1.7.x patch releases. Bundled here.

- **C2 / C3 — `failed_chunks` audit-table gap.** Notes that produce zero chunks bypass the audit table entirely (the table only records embedding *attempts* that errored), so `failedChunksTotal: 0` even when 108 notes are silently absent. Add a `reasonCode` column on `failed_chunks` (values: `no-embeddable-content`, `tokenizer-rejected`, `embedder-error`, `produced-zero-chunks`) so every "this note isn't indexed" case has a machine-readable cause. Ship alongside a new MCP tool `list_missing_embeddings({limit?})` so clients don't have to read `kg.db` directly to find which notes are missing. Tool count: 19 → 20 (or 21 if v1.8.0's `find_influential_notes_about` also lands).
- **C11 — multilingual-quality silently dropped 6 chunks.** Symptom of C2/C3: same fix surfaces them. The chunker proactively detects transformers.js#267 candidates pre-embed and discards them without recording. The new `produced-zero-chunks` reasonCode makes them visible.
- **C10 — vault-side ignore patterns.** Honor `.gitignore` if present; introduce `.obsidianbrainignore` for vaults that aren't git repos. Useful for test/CI vaults, transient `_test-runner/` paths, and `node_modules`-style noise that currently gets indexed and counted in `notesTotal`.
- **M1 — response-shape consistency pass.** Currently mixed: some tools return `{data: [...]}`, some return raw arrays, some return flat objects, some return `{data: {nodes, edges}}`. Pick one envelope (`{data, context?}`) and migrate every tool. Likely breaking — clients using `parsed?.data ?? parsed` defensively will keep working, but anyone strict-parsing will break. Plan as opt-in via response version negotiation, or accept the break with a major bump (push to v2.0 if so). **Folds in:** G7 (`rank_notes(metric: 'both')` returns `{influence, bridging}` while singles return `[...]`), M2 (`read_note` brief vs full lacks discriminator field), M4 (`index_status` mixes liveness flags + counts in one envelope — split or accept).
- **M3 — typed error codes.** Replace stringly-typed errors (`/companion plugin unavailable/`, `/dimensions not known yet/`, `/expected.*confirm:true/`) with `{code: 'E_PLUGIN_UNAVAILABLE'|...}` envelope. Lets clients handle failures structurally instead of regex-matching prose. Same breaking-vs-additive trade-off as M1. **Folds in:** G8 (`find_path_between` returns `{paths: []}` for both "no path within depth" AND "graph disconnected" — add a `reason` enum to disambiguate).

### v1.9.0 — graph analytics credibility writeup (~1 week)

Pairs with plugin v1.9.0 (alignment, no plugin code changes).

- **Evaluation on a real vault.** Publish top-10 PageRank results on the author's actual vault, manual hit-rate assessment, write up the methodology. Per the competitive-analysis critique: an honest 60% hit rate is more credible than silence.
- Blog post + README "how well does this work" section.
- No feature code — the work is the eval + writeup.

### v2.0 — daemon mode + ecosystem reach

Revisit when user demand (resource cost, install friction) actually surfaces. None of the below is committed or dated.

- **Multi-client daemon mode.** One long-running daemon + per-client stdio-proxy shims. Shared embedder + watcher + SQLite. Saves ~200 MB RAM per extra MCP client. Needs: daemon lifecycle (auto-start, health, restart), Unix socket transport (Windows: named pipe), graceful upgrade, per-client auth. Worth it only when running 3+ simultaneous MCP clients is common.
- **Community plugin registry submission.** PR `obsidian-brain-plugin` to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) for one-click install from Obsidian's in-app Community Plugins browser (no BRAT required). Wait until the plugin's endpoint surface has stabilised (post-v1.6.0 at earliest); registry review is 1–2 weeks and re-submitting after every API change is friction.
- **Dynamic Templater-style tool registration.** If the companion plugin is installed + Templater is enabled, scan the user's templates and register each as a typed MCP tool (parsing `tp.user.askString("X")` prompts into Zod schemas). Lets "Claude, make me a meeting note" become `meeting_notes({title, attendees, date})` with validation. High ceiling, niche audience.
- **Optional git integration** for write auditing. If the vault is a git repo, each agent-initiated edit becomes a commit with attribution (`agent: claude, tool: edit_note, note: X`). Auditable + recoverable. Opt-in config flag so non-git users are unaffected.

### Explicitly NOT planned

Stances worth naming so expectations stay calibrated:

- **Cloud embeddings** (OpenAI, Voyage, Cohere). Deliberate local-only stance — zero egress, works offline, nothing leaves the machine. The v1.4.0 `Embedder` interface is forkable if anyone wants a cloud variant, but it won't be a first-party config knob.
- **DQL execution without Obsidian running.** Reimplementing Dataview's query engine + metadata cache outside Obsidian is months of work for no meaningful gain over the companion-plugin approach.
- **Full Bases feature parity** — rendered card / calendar / map views. MCP returns data; rendering is the client's job.
- **DataviewJS / JS-block execution.** Arbitrary JS eval against the vault is a security hole; skip permanently.
- **Plugin writes from the server** (move Obsidian's cursor, open a file in the UI, inject text into the editor). The companion plugin is read-only by design. If we ever want this, it's a separately-scoped feature with its own threat model and opt-in.
- **Rewrite in Rust.** Node + sqlite-vec + transformers.js covers the performance envelope. A Rust rewrite would cost months for no user-visible win.
- **Collapse to 5 hub-tools (aaronsb-style).** Good pattern for single-surface operations; wrong for a tool set with distinct graph-analytics + writes + search semantics. We take the `next_actions` hint pattern (v1.5.0), not the tool-count philosophy.

## Ideas

New ideas go here. To add one from the command line: `npm run idea -- "your idea text"`.

<!-- IDEAS:start -->
- 2026-04-23 · Cross-vault search across multiple VAULT_PATHs
- 2026-04-23 · Auto-tag suggestions from embedding clusters
- 2026-04-23 · Periodic "what have I been working on?" digest tool using recent edit timestamps
<!-- IDEAS:end -->

## Versioning policy

Plugin and server ship aligned at **major.minor** — when server goes `X.Y.0`, plugin goes `X.Y.0` the same day (even if the plugin has no code changes, as a "version alignment" release with a CHANGELOG note). Patch versions may drift. The `capabilities[]` array in `discovery.json` remains the actual compatibility handshake; version numbers are a signal to users that "plugin 1.4.x works with server 1.4.x". The plugin jumps `0.2.1 → 1.4.0` in v1.4.0 to establish the alignment baseline.
