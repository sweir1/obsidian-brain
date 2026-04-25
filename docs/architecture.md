---
title: Architecture
description: Why obsidian-brain is stdio-only, SQLite-backed, chunk-level — and how all the pieces fit together.
---

# obsidian-brain architecture

This document explains *why* obsidian-brain is built the way it is. The [Quick start](getting-started.md) and [Tool reference](tools.md) cover *what* it does; this covers the decisions behind the structure, what each one trades away, and when you might want to revisit it.

## Module layout at a glance

```mermaid
flowchart LR
    CLI["cli/<br/>(user entry)"] --> Server["server.ts"]
    CLI --> Pipeline["pipeline/"]
    Server --> Tools["tools/<br/>(17 handlers)"]
    Tools --> Pipeline
    Tools --> Search["search/"]
    Tools --> Graph["graph/"]
    Tools --> Vault["vault/"]
    Tools --> Resolve["resolve/"]
    Pipeline --> Vault
    Pipeline --> Embedder["embeddings/"]
    Pipeline --> Graph
    Search --> Embedder
    Pipeline --> Store[("store/<br/>SQLite")]
    Search --> Store
    Graph --> Store
    Vault --> Store
    Resolve --> Store
```

One-way-ish deps: everything flows toward `store/`. Tools never reach into `store/` directly — they go through `search/` / `graph/` / `vault/` / `resolve/` which own the query shapes. That boundary lets us swap any store implementation without touching tool handlers.

## How indexing actually runs

```mermaid
flowchart LR
    Scan["Scan vault<br/>for .md files"] --> Diff{"mtime<br/>changed?"}
    Diff -->|"yes or new"| Parse["Parse frontmatter<br/>+ wiki-links"]
    Diff -->|"no"| Skip[Skip]
    Diff -->|"deleted"| Remove["deleteNode()"]
    Parse --> Chunk["Chunk<br/>(heading-aware,<br/>code/LaTeX preserved)"]
    Chunk --> Embed["Embed per chunk<br/>(SHA-256 content-hash dedup)"]
    Embed --> Store[("SQLite<br/>nodes · edges · chunks<br/>FTS5 · chunks_vec")]
    Remove --> Store
    Skip --> Done
    Store --> Done
    Done["All files handled"] --> Comm["Re-detect<br/>communities (Louvain)"]
    Comm --> Stats["Return IndexStats"]
```

Incremental by default — only files whose `mtime` has changed go through parse + embed. That's why a re-index of a 10k-note vault with nothing changed costs roughly one `stat()` per file.

## Why stdio, not HTTP

The single most consequential decision. `src/server.ts:56` instantiates a `StdioServerTransport` and nothing else — there is no HTTP listener, no SSE endpoint, no port binding anywhere in the codebase.

Arguments for stdio:

- **No network listener, no network failure modes.** No firewall prompt, no port conflict with whatever else you're running, no auth scheme to implement (and get wrong). The only ambient authority is "whoever can exec our binary."
- **Process lifetime tracks the client.** The MCP host (Claude Desktop, Claude Code, Jan, etc.) spawns the server as a child. When the client exits, the server exits. There is no "I closed Obsidian but the server is still holding a port" failure class, and no orphaned daemons to reap.
- **Immune to a whole class of MCP transport bugs.** The most topical example is [modelcontextprotocol/rust-sdk#468](https://github.com/modelcontextprotocol/rust-sdk/issues/468): rmcp's Streamable-HTTP client mis-parses SSE frames emitted by TypeScript-SDK servers, so the first request works and every subsequent request fails with "Transport closed." That bug is what causes the aaronsb Obsidian MCP plugin to break when paired with Jan. See [Appendix: the rmcp / SSE bug](#appendix-the-rmcp-sse-bug-in-detail) below.

Tradeoff given up: you cannot run obsidian-brain on a remote host and connect to it over LAN. If you need that topology, wrap the stdio server in `mcp-proxy` or similar — the vault is local anyway, and the desktop MCP client is almost always on the same box, so this rarely bites in practice.

## Why SQLite with FTS5 + sqlite-vec

The index is a single `better-sqlite3` file that holds everything: graph nodes, edges, communities, full-text index, vector embeddings, and per-file sync state. No separate vector DB (LanceDB, Chroma, Qdrant), no separate search daemon (Meilisearch, Tantivy).

Reference points in the code:

- Schema: `src/store/db.ts` — `nodes`, `edges`, `communities`, `sync`, `chunks`, `index_metadata`, plus `embedder_capability` and `failed_chunks` (both added in v1.7.0's schema v6 for the adaptive capacity + fault-tolerant embed loop; `embedder_capability` extended with seven metadata-cache columns in v1.7.5's schema v7), and the FTS5 virtual table `nodes_fts` (tokenizer `porter unicode61` since v1.4.0) and two sqlite-vec virtual tables: `nodes_vec` (mean-pooled note-level vector, kept for compat) and `chunks_vec` (per-chunk vectors, the main retrieval target since v1.4.0). The vec0 dim is reconciled against the embedder at runtime and `index_metadata` records the active embedding model/dim/provider so a mismatch on reboot triggers an auto-reindex (`src/pipeline/bootstrap.ts`). Auto-reindex also fires on schema-version bumps (v6 → v7), prefix-strategy changes (v1.5.1+), and provider switches (v1.7.2 — Ollama ↔ transformers also wipes `embedder_capability` and `failed_chunks` so stale capacity / metadata can't poison the next pass). `embedder_capability` caches per-model `(advertised_max_tokens, discovered_max_tokens, method, dim, query_prefix, document_prefix, prefix_source, base_model, size_bytes, fetched_at)` keyed on `(embedder_id, model_hash)` so the chunker picks a safe token budget AND the embedder applies the correct query/document prefix without re-probing on every boot; `fetched_at` drives the v1.7.5 90-day TTL (stale entries return cached + fire async refetch). `failed_chunks` records `(chunk_id, note_id, reason, error_message, failed_at)` for any chunk the fault-tolerant loop skipped (surfaced via the `index_status` tool); reasons include `too-long`, `embed-error`, `note-too-long`, `note-embed-error`, and `no-embeddable-content` (v1.7.3 — empty / frontmatter-only / sub-`minChunkChars` notes recorded once, never retried). Since v1.2.2 `deleteNode` also cascades to the `communities` table via `pruneNodeFromCommunities` (`src/store/communities.ts`); since v1.4.0 that prune also regenerates each affected cluster's `summary` string via `buildSummary` so `nodeIds` and `summary` stay consistent.
- Chunking: `src/embeddings/chunker.ts` (~337 LoC) — heading-aware recursive chunker, preserves code fences + `$$…$$` LaTeX via U+E000/U+E001 sentinel masking, dedups unchanged chunks across reindexes via SHA-256 content-hash so edits to a single section skip re-embedding the rest.
- Vector kNN: `src/store/embeddings.ts` + `src/store/chunks.ts` — `embedding MATCH ? AND k = ?` against `vec0`; chunk-level results group by `node_id` with max-score-per-note unless `unique: 'chunks'` is requested.
- Full-text: `src/store/fulltext.ts` — FTS5 `MATCH` with `ORDER BY bm25(nodes_fts, 5.0, 1.0)` (5× title weight vs body, since v1.4.0) and `snippet()` for excerpts.
- Hybrid fusion: `src/search/unified.ts` `hybrid()` — runs `semantic()` and `fulltext()` in parallel and fuses via Reciprocal Rank Fusion (RRF, k=60). This is the default `search` mode since v1.4.0.
- Sync state: `src/store/sync.ts` — tracks `(path, mtime, indexed_at)` for incremental re-index.

Why one file for all of it:

- **One data dir, one backup, one invariant.** If you `cp` the SQLite file, you've copied the entire index atomically. If you delete `DATA_DIR`, everything resets cleanly. There is no "the vector DB is ahead of the graph DB" drift to reason about.
- **Vault-relative path is the universal join key.** Every row everywhere uses the relative path (e.g. `Areas/Ideas/thought.md`) as its ID. Nodes, edges, embeddings, and sync all join on it. See `src/store/nodes.ts`, `src/store/edges.ts`, `src/store/embeddings.ts`.
- **better-sqlite3 is synchronous and fast.** For a single-vault, single-user workload there is no concurrent writer, so we skip connection pooling and async ceremony entirely. `src/store/db.ts:25` sets `journal_mode = WAL` for safe reads during writes and that is the whole concurrency story.

**Stub-lifecycle helpers (v1.5.8).** `src/store/nodes.ts` ships `pruneOrphanStubs`, `pruneAllOrphanStubs`, and `migrateStubToReal`. `move_note` and `delete_note` call these to clean up zero-inbound stubs left behind when a note is renamed or deleted; `create_note` repoints inbound edges from a matching stub to the new real note. `src/pipeline/indexer.ts` runs `resolveForwardStubs` + `pruneAllOrphanStubs` at the end of every `index()` call as a backstop.

**FTS5 hyphen-safe queries (v1.5.8).** `src/store/fts5-escape.ts` phrase-quotes user queries containing characters FTS5 treats as operators (`-`, `:`, `(`, `)`, `*`, etc.) so queries like `foo-bar-baz` don't crash. Pure-alphanumeric queries pass through unchanged, preserving `AND` / `OR` / `NEAR` for power users.

Tradeoff: sqlite-vec does a full scan for kNN. This is fine at the vault sizes we target (50k notes: subsecond on commodity hardware). Past roughly 500k notes you'd want an ANN index and this decision would need re-evaluation.

## Why local embeddings

The default model is `Xenova/bge-small-en-v1.5` (since v1.5.2; previously `all-MiniLM-L6-v2`) run locally via `@huggingface/transformers` with `dtype: 'q8'` quantization (`src/embeddings/embedder.ts`).

**Preset resolver (v1.5.2+, expanded in v1.7.0).** Rather than requiring users to memorise HF model paths, `src/embeddings/presets.ts` maps six named presets (`english`, `english-fast`, `english-quality`, `multilingual`, `multilingual-quality`, `multilingual-ollama`) plus two deprecated aliases (`fastest` → `english-fast`, `balanced` → `english`) to concrete model ids. `createEmbedder()` in `src/embeddings/factory.ts` always calls `resolveEmbeddingModel(process.env)` to determine which checkpoint to load, honouring the precedence `EMBEDDING_MODEL > EMBEDDING_PRESET > stored metadata > first-boot auto-recommend > default (english)`. First-boot auto-recommend (v1.7.0, in `src/embeddings/auto-recommend.ts`) samples Unicode blocks across the vault's `.md` files to pick `english` vs `multilingual` automatically when neither env var is set and the DB is fresh — "it just works" on first run without config. Tests that construct `TransformersEmbedder` directly bypass the factory and therefore bypass the preset resolver — the `DEFAULT_MODEL` constant in `embedder.ts` intentionally stays at `all-MiniLM-L6-v2` so those tests remain deterministic regardless of env state.

**Metadata resolution chain (v1.7.5+).** Per-model metadata (output dim, max tokens, query / document prefix, ONNX size) is no longer hardcoded. After the preset resolver picks a model id and `embedder.init()` loads the weights, `src/embeddings/metadata-resolver.ts` runs through a six-step chain to populate the metadata that `embedder.embed()` and the chunker need:

1. **`embedder_capability` cache hit** (fresh, < 90 days) → return.
2. **Stale cache hit** (≥ 90 days) → return cached AND fire async refetch (stale-while-revalidate; never blocks).
3. **Cache miss + bundled seed hit** (`data/seed-models.json` shipped in the npm tarball, regenerated at every release from MTEB's open-weights list + HF configs) → copy seed entry into the cache.
4. **Seed miss + live HF fetch** (`src/embeddings/hf-metadata.ts` reads `config.json` + `tokenizer_config.json` + `sentence_bert_config.json` + `config_sentence_transformers.json` + `modules.json` in parallel, plus the upstream `base_model`'s same JSON when the direct repo lacks `prompts`).
5. **HF unreachable + embedder loaded** → probe dim from the loaded pipeline; assume symmetric; 512 max tokens.
6. **All fail** → safe defaults + stderr warning. Boot continues — offline-first promise preserved.

`OBSIDIAN_BRAIN_REFETCH_METADATA=1` forces a synchronous refetch (cache invalidation). The chain replaces three hardcoded tables that v1.7.5 deleted: the `getTransformersPrefix(modelId, taskType)` if/else family-pattern chain in `embedder.ts`, the `KNOWN_MAX_TOKENS` validation map in `capacity.ts`, and the `dim / symmetric / sizeMb / lang` columns on each `EMBEDDING_PRESETS` row. Single source of truth becomes upstream HF configs; wrong-prefix bugs (the v1.7.4 paraphrase-MiniLM-L3-v2 → mdbr-leaf-ir symmetric/asymmetric flip we shipped by hand) become impossible.

Why not an API like OpenAI's `text-embedding-3-small`:

- **Zero egress.** Vault content never leaves the machine. For people whose notes include journal entries, client names, medical notes, or anything else they'd rather not mail to an LLM vendor, this is the whole game.
- **No API key, no quota, no billing.** Important for a tool that re-embeds on every file save without anyone thinking about it.
- **~34 MB one-time model download** for the default `bge-small-en-v1.5`, then tens of ms per note on CPU. Fast enough that the first full index of a 10k-note vault completes in minutes and incremental re-indexing is imperceptible.

Tradeoff: quality is measurably below modern API embeddings on hard semantic-similarity benchmarks. Since v1.4.0 the embedder is pluggable behind an `Embedder` interface (`src/embeddings/types.ts`). `src/embeddings/factory.ts` selects the backend on `EMBEDDING_PROVIDER` (`transformers` default; `ollama` alternative since v1.5.0); each backend reads `EMBEDDING_MODEL` to pick the specific checkpoint. The `index_metadata` table stores the active `embedding_model` + `embedding_dim` + `embedding_provider`; on startup `src/pipeline/bootstrap.ts` compares them against the current embedder's `modelIdentifier()`/`dimensions()` and auto-clears the chunk + vec tables if they've changed, so switching models is safe — **no manual `--drop` required**. The Ollama backend (`src/embeddings/ollama.ts`) also injects task-type prefixes automatically for the asymmetric embedding models that need them (`nomic-embed-text` gets `search_query: ` / `search_document: `; `qwen*` gets `Query: ` on the query side; `mxbai-embed-large` / `mixedbread*` get `Represent this sentence for searching relevant passages: ` on queries).

## Why incremental mtime sync

Incremental mtime-based sync is the foundation both the live watcher and the scheduled fallback share. `src/pipeline/indexer.ts:41` implements the full-vault pipeline: parse vault, diff against `sync` state, upsert the diff, re-run community detection if anything changed. Since v1.2.2, "anything changed" also counts deletions and an explicit `resolution` argument — before, a delete-only run or a resolution-change-with-no-mtime-change would silently skip community refresh and leave ghost node ids in the `communities` table.

Why mtime-keyed incrementality:

- **Incremental is cheap.** The indexer checks `stat.mtimeMs` against the stored mtime in `sync` (`src/pipeline/indexer.ts:159`); if the file hasn't changed it skips re-parsing and re-embedding entirely. A full re-scan of an already-indexed 10k-note vault costs roughly a `stat()` per file.
- **The per-file primitive is shared between live and batch.** `indexSingleNote` (`src/pipeline/indexer.ts:87`) is what the watcher calls per debounced change; `index()` loops it across the whole vault. Both read the same mtime state, so any path can be reindexed from either entry point without drift.
- **Robust to sleep/resume.** `systemd` with `Persistent=true` catches up on missed timer fires after the machine wakes; `launchd` with `StartInterval` does the equivalent on macOS. See `docs/launchd.md` and `docs/systemd.md` for the scheduled-fallback configs.
- **The fallback exists because watchers across macOS / Linux / iCloud-synced folders are a known rabbit hole.** FSEvents silently drops events under high churn, inotify watchers die on move/rename under some filesystems, and iCloud Drive materialises files lazily. If the watcher misses an event on your setup, disable it (`OBSIDIAN_BRAIN_NO_WATCH=1`) and run `obsidian-brain index` on a timer instead.

Default behaviour: the watcher keeps the index live as you edit. If you disable it or your vault lives somewhere it can't observe, the scheduled-index timer fills the gap. For an ad-hoc refresh after a big manual edit, call the `reindex` MCP tool from chat (`src/tools/reindex.ts`) or run `obsidian-brain index` directly.

## Live sync

The scheduled-index model above is still the fallback. The default, since v1.1, is a chokidar watcher spawned inside `obsidian-brain server`. See `src/pipeline/watcher.ts`. Chokidar uses the native platform API (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows), not polling, so idle CPU cost is effectively zero.

Each change event is keyed by path and fed through a per-file debounce (`src/pipeline/watcher.ts:DEFAULT_DEBOUNCE_MS`, 3000 ms). Obsidian writes files on a ~2s autosave cadence, often multiple times during a single editing burst; the debounce collapses those into a single reindex per pause. When the debounce fires we call `indexSingleNote` (`src/pipeline/indexer.ts:indexSingleNote`) — the same primitive the write tools use, so incremental and batch paths share one code path: parse frontmatter + inline Dataview fields + wiki-links, re-embed, upsert node + edges, mark the graph dirty.

Community detection is debounced separately on 60 s (`OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS`). Louvain runs over the entire graph and dominates cost on large vaults, so we batch it across many individual file changes. Per-file reindex stays snappy; community labels lag by up to a minute, which is fine because `detect_themes` is a background-style tool nobody refreshes every second.

Flow in one line: Obsidian saves file → chokidar emits `change` → 3 s debounce → `indexSingleNote` parses, embeds, upserts node + edges → community flagged dirty → 60 s later Louvain re-runs.

When to disable (`OBSIDIAN_BRAIN_NO_WATCH=1`): vault on SMB/NFS/iCloud where FSEvents/inotify don't fire reliably; shared-tenancy machines where you'd rather pay CPU on a fixed schedule than at edit time; or you already run a dedicated `obsidian-brain index` job and don't want two sources of writes.

**Write-safety infrastructure (v1.6.0).** Three new tool modules support the `dryRun` / `apply_edit_preview` / `edits[]` / `from_buffer` flow:

- `src/tools/preview-store.ts` — in-memory `Map<previewId, PendingEdit>` with 5-minute TTL and 50-entry cap. Process-global (stdio MCP is single-client per process).
- `src/tools/apply-edit-preview.ts` — the 17th MCP tool. Reads the cached preview, guards against file-changed-since-preview, writes via temp+rename, reindexes.
- `src/tools/edit-buffer.ts` — per-path buffer (30-min TTL, 20-entry cap, 512 KB per entry) of last-failed `replace_window` content for `from_buffer: true` retries.
- `src/vault/editor.ts` exports `applyEdit` + `bulkEditNote`; the latter chains edit modes in memory and writes atomically at the end.
- New runtime dependency: `diff@^8` (kpdecker/jsdiff) for unified-diff generation.

## Why modular file layout

The directory layout is:

- `src/server.ts` — MCP server bootstrap. Instantiates `McpServer`, wires `StdioServerTransport`, registers every tool, and starts the live watcher.
- `src/config.ts` / `src/context.ts` — env parsing and the shared `ServerContext` object (DB handle, embedder, vault path, pipeline, writer, search) passed to every tool.
- `src/cli/` — the `obsidian-brain` CLI entry point: `server`, `index`, `watch`, `search` subcommands.
- `src/store/` — SQLite schema and per-table CRUD (`db`, `nodes`, `edges`, `embeddings`, `fulltext`, `communities`, `sync`).
- `src/embeddings/` — the transformers.js Embedder wrapper. One file.
- `src/graph/` — graph construction (`builder`), centrality (`centrality`), Louvain community detection (`communities`), shortest paths (`pathfinding`), and the graphology-compat shim.
- `src/vault/` — reading, writing, parsing, and editing `.md` files on disk; wiki-link resolution; fuzzy filename matching.
- `src/search/` — unified semantic + full-text search surface.
- `src/resolve/` — fuzzy note-name resolution used by tools that accept human-typed note titles.
- `src/pipeline/` — the indexing orchestrator (`indexer.ts`) that stitches vault parsing, store writes, embedding, and community detection together; plus the chokidar watcher (`watcher.ts`) that drives `indexSingleNote` on debounced file-change events.
- `src/tools/` — one file per MCP tool. `register.ts` is the shared Zod/schema helper + (since v1.5.0) the `{data, context}` envelope wrapper — tools that return a `ContextualResult` get their `context.next_actions` serialised alongside `data`; tools that return a plain payload stay unchanged for backcompat. `hints.ts` holds the per-tool hint generators (`search`, `read_note`, `find_connections`, `delete_note` opt in).

Why this shape:

- **The original obra `graph.ts` was 324 lines** mixing graph construction, pathfinding, centrality, and Louvain into one module. Every change required re-reading the whole file to make sure you hadn't broken something in an unrelated concern. Splitting it along the natural algorithm boundaries made each piece independently greppable, testable, and swappable.
- **Swap surface area is small and local.** You can replace `src/graph/centrality.ts` with an approximate-pagerank variant without touching anything else; you can replace `src/store/embeddings.ts` with a HNSW-backed implementation without touching the graph code. Tools never reach into stores directly except via the exported functions.
- **The tool layer is flat on purpose.** `src/tools/*.ts` is one-file-per-tool because it matches the MCP surface 1:1 — when a user asks "what does `find_connections` do?", you open exactly one file.

## Features that require a companion plugin

Three capabilities only exist **inside a running Obsidian process** — not in the on-disk vault:

- **Dataview DQL queries** — Dataview's index and query engine live in Obsidian's memory.
- **Obsidian Bases** — view rows are computed against Obsidian's metadata cache.
- **Live-workspace / active-editor awareness** — which note is open and the cursor position only exist in the UI.

For these we ship an **optional** [`obsidian-brain-plugin`](https://github.com/sweir1/obsidian-brain-plugin) that runs inside Obsidian and exposes a localhost-only HTTP endpoint with bearer-token auth. The standalone MCP server discovers the plugin via a vault-scoped discovery file at `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` and proxies the plugin-dependent tools through it. Currently: `active_note` (server v1.2.0 / plugin v0.1.0+), `dataview_query` (server v1.3.0 / plugin v0.2.0+, **plus the third-party Dataview community plugin by blacksmithgu installed and enabled** in the same vault), and `base_query` (server v1.4.0 / plugin v1.4.0+, plus Obsidian ≥ 1.10.0 with the core Bases plugin enabled). When the plugin is absent or Obsidian isn't running, those tools surface an actionable install message; every other tool keeps working.

**Capability gating** (since v1.3.0): the plugin writes `capabilities: string[]` into `discovery.json` — v1.4.0+ emits `["status", "active", "dataview", "base"]`. `ObsidianClient.has(capability)` in `src/obsidian/client.ts` reads that list; capability-gated tools check before making the HTTP call and return a clean "upgrade to plugin vX.Y.Z" error when the installed plugin is too old, instead of opaque 404s from missing routes. Plugins without the `capabilities` field (v0.1.x) are treated as `["status", "active"]` for backward compatibility.

Why this shape (a plugin that's just a data provider, not an MCP server):

- **Keeps the MCP surface stdio-only.** Putting the MCP server inside the plugin, as [`aaronsb/obsidian-mcp-plugin`](https://github.com/aaronsb/obsidian-mcp-plugin) does, forces HTTP transport, which is what trips the rmcp SSE bug in Jan. Our stdio server sidesteps that entirely (see Appendix).
- **Keeps the "works without Obsidian" promise.** The standalone server and its 14 non-plugin-dependent tools (of 17 total) are fully functional with Obsidian closed.
- **Plugin is a minimal data provider, not a full MCP implementation.** A few HTTP routes, ~5 KB of bundled code. The tool surface, auth, schema validation, and MCP protocol handling all live in the Node server where they already work.

**Cloud embeddings** (OpenAI / Voyage / Cohere) are the one item in the "doesn't do" table that won't land via the plugin. That's a deliberate stance — fully local, zero egress, works offline. The `Embedder` interface is forkable if anyone wants cloud embeddings as a personal variant.

## Appendix: the rmcp / SSE bug in detail

This is the bug hiding behind decision #1. Understanding it makes the stdio choice feel less arbitrary.

The shape of the bug:

- MCP's Streamable HTTP spec allows a POST /mcp response to return either `application/json` (one-shot) or `text/event-stream` (SSE). Servers choose.
- The TypeScript MCP SDK's `StreamableHTTPServerTransport` defaults to SSE, emitting one frame per response and then closing the stream.
- rmcp's (Rust) client reads the first frame correctly but mis-handles the stream close as a transport-level disconnect rather than a normal end-of-response. Every subsequent request then fails with "Transport closed."
- Fixed upstream in [rust-sdk PR #467](https://github.com/modelcontextprotocol/rust-sdk/pull/467), tracked in [rust-sdk#468](https://github.com/modelcontextprotocol/rust-sdk/issues/468). As of this writing the fix has not shipped in Jan 0.7.9, so any rmcp-client + TS-SDK-SSE-server pairing breaks. `docs/jan.md` covers the workaround when you hit it.

Why stdio sidesteps this entirely: there is no stream framing to disagree about. stdio MCP is line-delimited JSON-RPC over a pipe. The transport has essentially no surface area to get wrong. As a class of bug, "SSE framing interop" cannot exist here.

This is also the general argument for stdio over HTTP for local tools: the protocol surface you get with stdio is small enough that implementations tend to agree, and the failure modes when they don't are obvious (the pipe dies, the child exits) rather than subtle (request 2 silently times out).
