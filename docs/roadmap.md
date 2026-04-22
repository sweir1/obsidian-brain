# Roadmap

What's shipped, what's next, what we've deliberately scoped out. Revised on each release.

*Last updated: 2026-04-22 (v1.4.0 + plugin v1.4.0 shipped; v1.5.0 scope below is planned and in-flight.)*

## Versioning policy

Plugin and server ship aligned at **major.minor** — when server goes `X.Y.0`, plugin goes `X.Y.0` the same day (even if the plugin has no code changes, as a "version alignment" release with a CHANGELOG note). Patch versions may drift. The `capabilities[]` array in `discovery.json` remains the actual compatibility handshake; version numbers are a signal to users that "plugin 1.4.x works with server 1.4.x". The plugin jumps `0.2.1 → 1.4.0` in v1.4.0 to establish the alignment baseline.

---

## Shipped

| Release | Scope | Paired plugin |
|---|---|---|
| v1.0.0 | Core: semantic search + knowledge graph + vault editing over stdio MCP | — |
| v1.1.x | Live file watcher (chokidar) replaces scheduled reindex; offline-catchup on boot | — |
| v1.2.0 | `active_note` via companion plugin (first plugin-dependent tool) | 0.1.0 |
| v1.2.1 | Defensive hardening — per-tool timeout, SQLite WAL `busy_timeout = 5000`, embedder request serialisation | 0.1.0 |
| v1.2.2 | Theme-cache correctness, `patch_heading` `scope: 'body'`, `valueJson` for stringifying harnesses | 0.1.0 |
| v1.3.0 | `dataview_query` + capability gating via plugin discovery | 0.2.0 |
| v1.3.1 | Discriminated Dataview 424 responses (not-installed / not-enabled / api-not-ready) + doc-currency fixes | 0.2.1 |
| v1.4.0 | Retrieval-quality foundation (chunks + hybrid RRF + configurable embedder) + Bases via Path B + P0/P1 correctness fixes | 1.4.0 |

---

## Next up

### v1.4.0 — retrieval quality + Bases + correctness (shipped)

Pairs with **plugin v1.4.0** (version alignment jump from 0.2.1). Three pillars:

**A — correctness fixes from field-test feedback (P0/P1):**
- `delete_note` invalidates the theme cache (regenerates cluster `summary` from the live member list on write); `detect_themes` also lazy-filters + regenerates on read as belt-and-braces.
- `reindex({})` default `resolution: 1.0` so the bare call does what the description promises.
- `patch_heading` returns `removedLen` / `linesConsumed` so callers can detect greedy trailing-heading consumption; body-scope no longer produces a double blank line.
- Doc-note that `create_note` / `move_note` auto-inject `title:` frontmatter.

**B — retrieval foundation:**
- **Chunk-level embedding.** New `chunks` + `chunks_vec` tables. Heading-aware recursive chunker that preserves code + LaTeX blocks. SHA-256 content-hash dedup means unchanged chunks don't re-embed. Search returns one row per note by default (best chunk's score wins) with opt-in `unique: 'chunks'` for chunk-level inspection.
- **Hybrid RRF search as default.** `mode: 'hybrid' | 'semantic' | 'fulltext'` — default `hybrid` runs both semantic and full-text, fuses via Reciprocal Rank Fusion. Clients call `search({query})` with no mode param; semantic + fulltext remain explicit escape hatches.
- **FTS5 polish.** Porter stemming via `tokenize='porter unicode61'`; BM25 column-weighted `bm25(nodes_fts, 5.0, 1.0)` (5× title vs body).
- **Configurable + pluggable embedder.** New `Embedder` interface. `TransformersEmbedder` default (reads `EMBEDDING_MODEL` env). `index_metadata` table stores model + dim; switching model auto-reindexes on next boot. Recommendation table in README for MiniLM / bge-small / bge-base / multilingual.

**C — Obsidian Bases integration:**
- Plugin `/base` route + `resolveBases()` discriminated union (`not_enabled` / `unsupported_obsidian_version`). Appends `"base"` to capabilities.
- Server-side `base_query` MCP tool — new tool surface (tool count 15 → 16).
- **Path B implementation** (own YAML parser + expression evaluator) — Obsidian's public API still has no read-access surface as of 1.12.7 (forum request open since 2026-01-31, unacknowledged). Public `BasesQueryResult` types are stable since 1.10, so a future Path A swap-in is drop-in.
- **v1.4.0 supported subset:** tree ops (`and`/`or`/`not` nested), comparisons, leaf boolean, file props (`file.name/path/folder/ext/size/mtime/ctime/tags`), `file.hasTag`/`file.inFolder`, frontmatter dot-access.
- **Rejected with clear "unsupported construct" errors:** arithmetic, method calls, function calls, regex literals, `formulas:`, `summaries:`, `this`. These are staged:
  - v1.4.1 — arithmetic + date arithmetic + method calls.
  - v1.4.2 — formulas.
  - v1.4.3 — summaries.

**Effort:** ~12–18 h focused. **Risk:** medium — Path B evaluator has semantic-drift risk vs. Obsidian's evaluator (mitigated by fixture-driven tests against real `.base` files in a tiny vault).

### v1.5.0 — agent UX + Ollama + deferred polish

Pairs with **plugin v1.5.0** (version-alignment release; no plugin code changes). No new MCP tools — tool count stays at 16.

- **Ollama embedding provider** via the v1.4 `Embedder` interface. `EMBEDDING_PROVIDER=ollama` + `EMBEDDING_MODEL=nomic-embed-text` (etc.). Task-type prefixes for asymmetric models (nomic / qwen / mxbai) are applied automatically — the single detail most third-party integrations get wrong and it costs ~10-20% retrieval quality.
- **`next_actions` state hints in tool responses** (opt-in per tool). Shared `{data, context: {state, next_actions}}` envelope at `src/tools/register.ts`. Five tools get hints day-one: `search` (top hit → `read_note`), `read_note` (unresolved links → `create_note`), `find_connections` (many connections → `detect_themes`), `detect_themes` (per cluster → `rank_notes`), `delete_note` (orphan check). Additive — clients ignoring the field keep working unchanged.
- **Deferred UX (L1/L3/L4/L5)** from prior feedback:
  - L1: `move_note` rewrites inbound `[[wiki-links]]` across the vault after rename. Response reports `linksRewritten: {files, occurrences}`.
  - L3: `patch_heading` on multi-match raises a clear error listing each occurrence + line number; `headingIndex?: number` to disambiguate explicitly.
  - L4: `read_note` returns `truncated: true` when `maxContentLength` cuts the body.
  - L5: `includeStubs?: boolean` (default true) on `detect_themes` + `rank_notes` (matches `list_notes`).
- **Graph analytics credibility guards.** `rank_notes(pagerank)` excludes nodes with `< 2` incoming links by default (tunable). `detect_themes` adds `warning` to the response when Louvain modularity is `< 0.3`. `rank_notes(bridging)` normalizes betweenness by `n*(n-1)/2` so values compare across vault sizes.

**Explicitly deferred from v1.5.0** (earn their own milestones — see v1.6.0):
- L2 — `dryRun?: boolean` on write tools. Needs its own design pass on diff format + preview/apply split.
- L6 — bulk `edit_note` tuple array with atomic rollback. Heavy + high-value.

**Effort:** ~8–12 h focused. **Risk:** low — additive UX + a single new provider behind an existing interface.

---

## Future milestones

### v1.6.0 — agentic-writes safety bundle (~2 weeks)

Pairs with plugin v1.6.0 (version alignment, no plugin code changes expected).

- **`dryRun: true` on write tools** (`edit_note`, `move_note`, `delete_note`, `link_notes`). Returns the proposed diff without committing. Unified-diff string per file; preview-ID handed back for a separate `apply_edit_preview(previewId)` commit. L2 from feedback.
- **Bulk `edit_note`** — tuple array, atomic rollback via SQLite savepoint + filesystem journal. L6 from feedback.
- **Fuzzy matching on window edits.** `fuzzy_threshold: 0.9` param; Levenshtein match when exact fails. Typo-tolerant edit targets.
- **Content buffer for failed edits.** Session-keyed; `edit_note(from_buffer: true)` retrieves and retries. Prevents "Claude wrote 500 tokens, edit failed, has to rewrite everything."

### v1.7.0 — block-ref editing + FTS5 frontmatter + topic-aware PageRank (~1-2 weeks)

Pairs with plugin v1.7.0.

- **`edit_note(mode: 'patch_block', block_id: '^abc123')`.** Parse `^[a-zA-Z0-9-]+$` at line end into a new `block_refs(id, node_id, start_line, end_line)` table; boundary is text from ID back to previous blank line or previous block ID. Meaningful Obsidian-power-user gap (lstpsche ships it, we don't). Adds one tool — count becomes 17.
- **FTS5 frontmatter fielding.** Tokenize frontmatter alongside title + body as a fielded index, moderate 2× boost. Complements v1.4.0's stemming + column-weighted BM25.
- **`find_influential_notes_about(topic)`.** The tool only obsidian-brain can ship because only it co-locates both signals: semantic neighborhood → induced subgraph → PageRank on the subgraph. Replaces the noisy full-vault PageRank for topic-aware "what are the hubs here". One new tool — count becomes 18.

### v1.8.0 — graph analytics credibility writeup (~1 week)

Pairs with plugin v1.8.0 (alignment, no plugin code changes).

- **Evaluation on a real vault.** Publish top-10 PageRank results on the author's actual vault, manual hit-rate assessment, write up the methodology. Per the competitive-analysis critique: an honest 60% hit rate is more credible than silence.
- Blog post + README "how well does this work" section.
- No feature code — the work is the eval + writeup.

---

## v2.0 — daemon mode + ecosystem reach

Revisit when user demand (resource cost, install friction) actually surfaces. None of the below is committed or dated.

- **Multi-client daemon mode.** One long-running daemon + per-client stdio-proxy shims. Shared embedder + watcher + SQLite. Saves ~200 MB RAM per extra MCP client. Needs: daemon lifecycle (auto-start, health, restart), Unix socket transport (Windows: named pipe), graceful upgrade, per-client auth. Worth it only when running 3+ simultaneous MCP clients is common.
- **Community plugin registry submission.** PR `obsidian-brain-plugin` to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) for one-click install from Obsidian's in-app Community Plugins browser (no BRAT required). Wait until the plugin's endpoint surface has stabilised (post-v1.5.0 at earliest); registry review is 1–2 weeks and re-submitting after every API change is friction.
- **Dynamic Templater-style tool registration.** If the companion plugin is installed + Templater is enabled, scan the user's templates and register each as a typed MCP tool (parsing `tp.user.askString("X")` prompts into Zod schemas). Lets "Claude, make me a meeting note" become `meeting_notes({title, attendees, date})` with validation. High ceiling, niche audience.
- **Optional git integration** for write auditing. If the vault is a git repo, each agent-initiated edit becomes a commit with attribution (`agent: claude, tool: edit_note, note: X`). Auditable + recoverable. Opt-in config flag so non-git users are unaffected.

---

## Explicitly NOT planned

Stances worth naming so expectations stay calibrated:

- **Cloud embeddings** (OpenAI, Voyage, Cohere). Deliberate local-only stance — zero egress, works offline, nothing leaves the machine. The v1.4.0 `Embedder` interface is forkable if anyone wants a cloud variant, but it won't be a first-party config knob.
- **DQL execution without Obsidian running.** Reimplementing Dataview's query engine + metadata cache outside Obsidian is months of work for no meaningful gain over the companion-plugin approach.
- **Full Bases feature parity** — rendered card / calendar / map views. MCP returns data; rendering is the client's job.
- **DataviewJS / JS-block execution.** Arbitrary JS eval against the vault is a security hole; skip permanently.
- **Plugin writes from the server** (move Obsidian's cursor, open a file in the UI, inject text into the editor). The companion plugin is read-only by design. If we ever want this, it's a separately-scoped feature with its own threat model and opt-in.
- **Rewrite in Rust.** Node + sqlite-vec + transformers.js covers the performance envelope. A Rust rewrite would cost months for no user-visible win.
- **Collapse to 5 hub-tools (aaronsb-style).** Good pattern for single-surface operations; wrong for a tool set with distinct graph-analytics + writes + search semantics. We take the `next_actions` hint pattern (v1.5.0), not the tool-count philosophy.

---

## How this list updates

- Every release bumps the "shipped" table.
- Anything in "next up" that ships moves up; anything learned during execution (scope revisions, newly-discovered risk) edits the entry in place.
- "Future milestones" items only move up into "next up" when they become the most-leveraged work. Order is defensible but not sequential — v1.7 could preempt v1.6 if block-ref editing becomes the load-bearing gap.
- Field-test feedback and user issues add entries; nothing gets added speculatively.
- Items in "NOT planned" require a documented reason to move out of that bucket.

For bug fixes and maintenance releases that don't change the roadmap shape, only the "shipped" table gets a row.
