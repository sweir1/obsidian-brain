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

### v1.7.20 — remaining audit follow-ups (~1 week)

Polish-tier items from the external test-harness audit (`feedback/OBSIDIAN_BRAIN_ISSUES.md`, generated 2026-04-26) that didn't fit v1.7.19's surgical scope. None require a schema change or breaking-API shift.

- **V1 — aggregate ambiguous-wiki-link warnings.** Currently emits one stderr line per occurrence of every ambiguous target on every link-graph walk (~1224 lines per 10k-vault reindex, 98.7% of all stderr volume). Replace with a per-target dedup map so each ambiguous target shows up at most once per reindex. ~20-line fix in the resolver.
- **V2 — link resolver matches Obsidian's preference order.** `[[America]]` resolving to `Fleeting/America.md, Misc/America.md, Permanent/America.md` currently picks first-scanned. Obsidian's own resolver prefers same-folder-then-most-recently-modified. Bring the graph in line with what users see in the Obsidian UI.
- **N3 — wire `index_status.initError` for async-init failure paths.** Currently the field is only populated by `server.ts`'s background catch block; tool handlers that hit the same `initPromise` rejection don't write it back. Centralise in `ensureEmbedderReady()`.
- **C5 — rephrase the "wiping sync.mtime to retry on next boot" stderr line.** Reads like recovery is happening; in practice the next boot scans the same files with the same chunker and produces the same outcome. Say what's actually happening.
- **C8 — populate `lastReindexReasons` for explicit user-triggered reindexes.** Currently empty after a tool-call reindex, even though the tool call was the trigger.
- **O5 / O7 / O8 — Ollama polish.** Strip the workaround-in-error-message hint that v1.7.19's `dimensions()` rethrow makes obsolete. Verify Qwen3's 32k context isn't being capped by a hardcoded smaller budget. Make `models recommend` Ollama-aware (currently picks between transformers.js presets only).
- **E1 / E2 / E3 — env-var doc updates.** Crisper `OBSIDIAN_BRAIN_NO_CATCHUP=1` semantics. Per-tool `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS` override map (reindex 25 s vs search 8 ms shouldn't share one timeout). Per-model `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS` overrides.
- **D3 / D4 — document `embedder_capability` + `index_metadata` table schemas in `docs/architecture.md`.** Internal today; surface them so users debugging "why does my preset use the wrong dim?" can read the cache row directly.
- **V4 — optional NDJSON stderr.** Add `OBSIDIAN_BRAIN_LOG_FORMAT=ndjson` for structured log aggregators. Default stays plain-text for terminal readability.
- **V5 — parameterise the first-time-index hint.** "may take 30-60s" understates 10k-note vaults (~3 min observed). Either size-aware or vaguer wording.

#### v1.7.19 test-coverage gaps to close

The v1.7.19 fixes ship with 21 new unit tests, but three call-site / wiring gaps were left open. Surgical additions; no new code paths, just regression hardening.

- **L1 integration test.** Add to `test/integration/server-stdin-shutdown.test.ts`: spawn the server, kick a background reindex via the existing watcher path, send SIGTERM mid-flight, capture stderr, assert no `database connection is not open` lines. Today's unit tests in `test/context.test.ts` verify the await-pattern *semantics* but not that `src/server.ts:178-187` actually uses it — a typo removing the `await Promise.race(...)` would still pass every existing test. Heavy because it needs a real embedder ready before the SIGTERM, but the existing integration test already pays that cost — extending it is cheap.
- **G1 `refreshCommunities` direct assertion.** Add to `test/pipeline/indexer/index.test.ts` (or wherever the pipeline tests live): build a graph with mixed real + stub nodes, call `pipeline.refreshCommunities()`, query the `communities` table, assert no community has any `_stub/*` ID in its `nodeIds`. Today the builder is tested directly and the tools are tested through the builder, but `refreshCommunities`'s exact `KnowledgeGraph.fromStore(this.db)` call site at `src/pipeline/indexer/index.ts:267` is verified only implicitly. If someone passes `{ includeStubs: true }` here by mistake, the harness would catch it on next re-run but the unit suite wouldn't.
- **C7 `rng` option is forwarded.** Spy on the louvain import in `test/graph/communities.test.ts` and assert `louvain` was called with `options.rng` set to a function. Today's tests verify partition determinism (the contract) but a graphology upgrade that renames the option (`rng` → `random` / `seed` / etc.) would silently fall back to `Math.random` while still appearing deterministic on small test graphs — failure would only surface on a large vault under the harness.

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
- **M1 — response-shape consistency pass.** Currently mixed: some tools return `{data: [...]}`, some return raw arrays, some return flat objects, some return `{data: {nodes, edges}}`. Pick one envelope (`{data, context?}`) and migrate every tool. Likely breaking — clients using `parsed?.data ?? parsed` defensively will keep working, but anyone strict-parsing will break. Plan as opt-in via response version negotiation, or accept the break with a major bump (push to v2.0 if so).
- **M3 — typed error codes.** Replace stringly-typed errors (`/companion plugin unavailable/`, `/dimensions not known yet/`, `/expected.*confirm:true/`) with `{code: 'E_PLUGIN_UNAVAILABLE'|...}` envelope. Lets clients handle failures structurally instead of regex-matching prose. Same breaking-vs-additive trade-off as M1.

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
