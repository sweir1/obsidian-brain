---
title: Tool reference
description: All 17 MCP tools obsidian-brain exposes — arguments, behaviour, examples.
---

# Tool reference

17 tools, grouped by intent. Every tool description below includes a one-line Claude prompt you can copy-paste into chat to nudge routing in the right direction.

Tools marked **requires companion plugin** only work when the [companion Obsidian plugin](plugin.md) is installed and Obsidian is running. Every other tool works standalone against the vault on disk.

## Find

### `search`

Find notes by meaning (chunk-level semantic similarity) or by exact text (SQLite FTS5 with Porter stemming + BM25 `title:body = 5:1`). The default `hybrid` mode fuses both rankings via Reciprocal Rank Fusion.

<!-- GENERATED:tool:search -->
| Arg | Type | Description |
|---|---|---|
| `query` | string | Natural-language query or keyword phrase. |
| `mode` | `"hybrid"` \| `"semantic"` \| `"fulltext"`? | Default `hybrid`. Semantic-only queries chunk vectors; fulltext-only queries FTS5. |
| `limit` | number? | Max results to return. Default 20. |
| `unique` | `"notes"` \| `"chunks"`? | Default `"notes"` (one row per note). Set `"chunks"` for raw chunk rows with chunkHeading, chunkStartLine, chunkExcerpt. |
<!-- /GENERATED:tool:search -->

The response is wrapped as `{data, context}` — `context.next_actions` suggests the most useful follow-up call (e.g. `read_note(top hit)`, `find_connections(top-3)`, or a simplified query retry on zero hits). Clients that ignore `context` keep working.

`mode: 'hybrid' + unique: 'chunks'` returns chunk metadata (including `chunkHeading`, `chunkStartLine`, `chunkExcerpt`). FTS5 queries containing `-`, `:`, `/`, or parens are auto-phrase-quoted — a query like `foo-bar-baz` no longer crashes.

> *"Use `search` to find notes semantically about supply-chain tax."*

### `list_notes`

List notes, optionally filtered by directory, tag, or link-target status.

<!-- GENERATED:tool:list_notes -->
| Arg | Type | Description |
|---|---|---|
| `directory` | string? | Restrict to notes under this subdirectory prefix. |
| `tag` | string? | Restrict to notes containing this frontmatter tag. |
| `limit` | number? | Max results to return. Default 100. |
| `includeStubs` | boolean? | Default `true`. Set `false` to exclude unresolved wiki-link targets. |
<!-- /GENERATED:tool:list_notes -->

> *"Use `list_notes` to list every note under `Projects/` tagged `#active`."*

### `read_note`

Read a note's metadata (and optionally its full body). Fuzzy-matches filenames, so "Q4 planning" resolves to `Meetings/2025-Q4 planning.md` if unambiguous.

<!-- GENERATED:tool:read_note -->
| Arg | Type | Description |
|---|---|---|
| `name` | string | Path, filename, or fuzzy match for the note to read. |
| `mode` | `"brief"` \| `"full"`? | Default `"brief"` (metadata + linked-note titles). `"full"` adds the body + edge context. |
| `maxContentLength` | number? | In `full` mode, max body chars before truncation. Default 2000. |
<!-- /GENERATED:tool:read_note -->

In `full` mode, the response includes `truncated: true` when the body exceeded `maxContentLength` and was sliced. Wrapped as `{data, context}` with `next_actions` hints — e.g. `create_note` for unresolved `[[links]]`, `find_connections` for outgoing neighbours.

> *"Use `read_note` to open the note called 'Q4 planning' with `mode: 'full'`."*

## Map the graph

### `find_connections`

N-hop link neighborhood around a note. Returns inbound + outbound links grouped by hop distance, optionally the full subgraph for visualization.

<!-- GENERATED:tool:find_connections -->
| Arg | Type | Description |
|---|---|---|
| `name` | string | Starting note (path or fuzzy match). |
| `depth` | number? | Number of hops to traverse. Default 1, max 3. |
| `returnSubgraph` | boolean? | Return all edges in the neighborhood as a full subgraph instead of a flat list. |
<!-- /GENERATED:tool:find_connections -->

Response is wrapped as `{data, context}` — `context.next_actions` suggests `detect_themes` when the neighbourhood is large (> 10) and `find_path_between` to the furthest neighbour. Clients that ignore `context` keep working.

> *"Use `find_connections` to show everything within 2 hops of `Epistemology.md`."*

### `find_path_between`

Shortest link chain(s) between two notes. Optionally return their shared neighbors as well.

<!-- GENERATED:tool:find_path_between -->
| Arg | Type | Description |
|---|---|---|
| `from` | string | Source note (path or fuzzy match). |
| `to` | string | Target note (path or fuzzy match). |
| `maxDepth` | number? | Maximum path length in hops. Default 3. |
| `includeCommon` | boolean? | Also return notes that both `from` and `to` link to (shared neighbors). |
<!-- /GENERATED:tool:find_path_between -->

> *"Use `find_path_between` to find how `Bayesian updating` connects to `Kelly criterion`."*

### `detect_themes`

Auto-detected topic clusters via [Louvain community detection](https://en.wikipedia.org/wiki/Louvain_method) over the backlink graph. Served from the community-detection cache; to recompute at a different resolution, call `reindex({resolution: X})` first.

<!-- GENERATED:tool:detect_themes -->
| Arg | Type | Description |
|---|---|---|
| `themeId` | string? | Drill into a single cluster by its id or label. |
| `includeStubs` | boolean? = true | Default `true`. Set `false` to exclude unresolved wiki-link targets from cluster membership. |
<!-- /GENERATED:tool:detect_themes -->

Each cluster carries `staleMembersFiltered` — cached `nodeIds` that no longer exist on disk and were filtered on this read; a positive value triggers live regeneration of `summary` so the two fields stay consistent. If the vault's overall Louvain modularity is `< 0.3`, the response wraps as `{clusters, warning, modularity}` — the clusters aren't clearly separable and may not reflect meaningful themes.

> *"Use `detect_themes` to surface the main themes across my vault."*

### `rank_notes`

Top notes by `influence` (PageRank over backlinks), `bridging` (betweenness centrality, normalized 0–1 so scores compare across vaults), or `both`.

<!-- GENERATED:tool:rank_notes -->
| Arg | Type | Description |
|---|---|---|
| `metric` | `"influence"` \| `"bridging"` \| `"both"`? | Ranking metric. Default `"both"`. `"influence"` = PageRank; `"bridging"` = betweenness centrality. |
| `limit` | number? | Max results to return. Default 20. |
| `themeId` | string? | Restrict ranking to members of one theme cluster. |
| `includeStubs` | boolean? = true | Default `true`. Set `false` to exclude unresolved wiki-link targets from the ranked set. |
| `minIncomingLinks` | number? = 2 | Minimum incoming links for influence ranking. Default 2. Pass 0 to see unfiltered PageRank. |
<!-- /GENERATED:tool:rank_notes -->

> *"Use `rank_notes` with `metric: 'influence'` to list the top 10 most-linked-to notes."*

## Write

### `create_note`

Create a new note with frontmatter and auto-index it. `title:` is auto-injected from the filename unless you explicitly pass `frontmatter: { title: null }`.

<!-- GENERATED:tool:create_note -->
| Arg | Type | Description |
|---|---|---|
| `title` | string | Note title. Used as the filename base and auto-injected into frontmatter. |
| `content` | string | Markdown body (do not include frontmatter here). |
| `directory` | string? | Vault-relative subdirectory to create the note in. |
| `frontmatter` | object? | YAML frontmatter key/value map. `title` is auto-injected unless explicitly set. |
<!-- /GENERATED:tool:create_note -->

Since v1.5.8, creating a note that matches an existing `[[ForwardRef]]` stub automatically repoints the stub's inbound edges to the real note and deletes the stub.

> *"Use `create_note` to create `Meetings/2026-04-21 standup.md` with tags `[meeting, standup]`."*

### `edit_note`

Modify an existing note. Six modes: `append`, `prepend`, `replace_window` (find-and-replace; optionally fuzzy), `patch_heading`, `patch_frontmatter`, `at_line`.

<!-- GENERATED:tool:edit_note manual -->
| Arg | Type | Description |
|---|---|---|
| `name` | string | Path or fuzzy match. |
| `mode` | one of the six | Required. |
| `content` | string | New content (mode-dependent). |
| `search` | string | For `replace_window`: the block of text to locate. |
| `fuzzy` | boolean | For `replace_window`: tolerate whitespace + trailing punctuation drift. |
| `heading` | string | Target heading (for `patch_heading`). |
| `headingOp` | `"replace"` \| `"before"` \| `"after"` | For `patch_heading`. `replace` (default) replaces the section below the heading; `before` / `after` insert adjacent to the heading line. |
| `scope` | `"section"` \| `"body"` | For `patch_heading replace`: `section` (default) consumes until the next same-or-higher heading or EOF; `body` stops at the first blank line. |
| `headingIndex` | number | For `patch_heading` when the heading text appears more than once — 0-indexed top-to-bottom picker. Without it, multiple matches throw `MultipleMatchesError` listing each occurrence with line numbers. |
| `line` / `lineOp` | | For `at_line`. |
| `key` / `value` / `valueJson` | | For `patch_frontmatter`. Use `valueJson` from clients that stringify tool params (e.g. `valueJson: 'null'` to clear a key, `valueJson: 'true'` for a real boolean, `valueJson: '42'` for a number). |
<!-- /GENERATED:tool:edit_note -->

`patch_heading` responses include `removedLen` so callers can detect greedy trailing-heading consumption.

- `dryRun: true` → returns a unified diff + `previewId`; no file is mutated. Commit the preview with `apply_edit_preview({ previewId })`.
- `edits: [...]` — bulk edit array applied atomically on a single file. All or nothing; error names the failing index if any edit fails.
- `fuzzyThreshold: 0–1` on `replace_window` (default `0.7`). Higher = stricter match required.
- `from_buffer: true` — on `replace_window` NoMatch, the proposed content is held in a buffer; retry via `from_buffer: true` retries with `fuzzy: true, fuzzyThreshold: 0.5`.

> *"Use `edit_note` to append a 'Follow-ups' section to today's standup note."*

### `apply_edit_preview`

Commit an edit previewed via `edit_note({ dryRun: true })`.

```
apply_edit_preview({ previewId: "prev_..." })
```

<!-- GENERATED:tool:apply_edit_preview -->
| Arg | Type | Description |
|---|---|---|
| `previewId` | string | The previewId returned by `edit_note` with `dryRun: true`. |
<!-- /GENERATED:tool:apply_edit_preview -->

- Preview not found or expired (5 min TTL) → error; regenerate the preview.
- Target file changed since preview was generated → error; regenerate the preview.

Added in v1.6.0.

### `link_notes`

Add a wiki-link between two notes plus a "why this connects" context sentence placed where the link is inserted.

<!-- GENERATED:tool:link_notes -->
| Arg | Type | Description |
|---|---|---|
| `source` | string | Source note to add the link from (path or fuzzy match). |
| `target` | string | Target note to link to (path, title, or new wiki-link ref). |
| `context` | string | One-sentence explanation of why these notes are connected. |
| `dryRun` | boolean? | If true, return the line that would be appended without writing. |
<!-- /GENERATED:tool:link_notes -->

`dryRun: true` (v1.6.0) returns the line that would be appended without writing.

> *"Use `link_notes` to link `Bayesian updating` to `Kelly criterion` with a note about risk-adjusted bets."*

### `move_note`

Rename or move a note. All inbound wiki-links (`[[old]]`, `[[old|alias]]`, `![[old]]`, `[[old#heading]]`, `[[old^block]]`) are rewritten in place across every note that linked to the old stem; graph edges stay intact.

<!-- GENERATED:tool:move_note -->
| Arg | Type | Description |
|---|---|---|
| `source` | string | Current path or fuzzy match of the note to move. |
| `destination` | string | New vault-relative path (including `.md`). `.md` is appended automatically if omitted. |
| `dryRun` | boolean? | If true, report what would be rewritten without mutating any files. |
<!-- /GENERATED:tool:move_note -->

Response adds `linksRewritten: {files, occurrences}` counting the rewrites applied.

`dryRun: true` (v1.6.0) reports what would be rewritten without mutating. Response on a real move includes `stubsPruned: N` (v1.5.8).

> *"Use `move_note` with `source: 'Inbox/thought.md'` and `destination: 'Areas/Ideas/thought.md'`."*

### `delete_note`

Delete a note. Requires `confirm: true` as a Zod-level guard.

<!-- GENERATED:tool:delete_note -->
| Arg | Type | Description |
|---|---|---|
| `name` | string | Path or fuzzy match of the note to delete. |
| `confirm` | true | Must literally be `true` to execute. Guards against accidental deletion. |
| `dryRun` | boolean? | If true, report what would be deleted without removing any files. |
<!-- /GENERATED:tool:delete_note -->

When the delete removed inbound edges, the response is wrapped in a `{data, context: {next_actions}}` envelope suggesting `rank_notes({metric: 'influence', minIncomingLinks: 0})` as a follow-up to surface newly orphaned notes.

`dryRun: true` (v1.6.0) reports what would be deleted. Real deletes surface `deletedFromIndex.stubsPruned: N` (v1.5.8) when the deleted note's orphan-stub targets were cleaned up.

> *"Use `delete_note` with `confirm: true` to delete `Inbox/obsolete.md`."*

## Live editor

These tools **require the [companion plugin](plugin.md)** installed in your vault and Obsidian running.

### `active_note`

Returns the note currently open in Obsidian — path, cursor position, and selection range. Requires plugin v0.1.0+.

<!-- GENERATED:tool:active_note -->
_No arguments._
<!-- /GENERATED:tool:active_note -->

> *"Use `active_note` to see what note I'm editing right now."*

### `dataview_query`

Run a [Dataview](https://blacksmithgu.github.io/obsidian-dataview/) DQL query. Returns a normalised discriminated union:

- `kind: "table"` → `{ headers, rows }`
- `kind: "list"` → `{ values }`
- `kind: "task"` → `{ items: [...] }` with full STask fields
- `kind: "calendar"` → `{ events: [...] }`

All Dataview `Link` / `DateTime` / `DataArray` / `Duration` values are flattened to JSON so tools consuming the output don't need Dataview runtime types.

<!-- GENERATED:tool:dataview_query -->
| Arg | Type | Description |
|---|---|---|
| `query` | string | DQL source, e.g. 'TABLE file.name, rating FROM #book WHERE status = "reading" LIMIT 50' |
| `source` | string? | Optional origin file path (vault-relative) to set the DQL origin. Affects `FROM ""` and relative link resolution inside the query. |
| `timeoutMs` | number? | HTTP timeout in ms (default 30000). The Dataview query itself cannot be cancelled; this just bounds how long this tool waits. |
<!-- /GENERATED:tool:dataview_query -->

Requires:

1. Companion plugin v0.2.0+ (see [plugin.md](plugin.md)).
2. The third-party **Dataview community plugin** by [blacksmithgu](https://github.com/blacksmithgu/obsidian-dataview) — a separate community plugin with ~4M+ installs, not shipped with Obsidian or by us. Install via Obsidian → Settings → Community plugins → Browse → search "Dataview" → Install → Enable.

If Dataview isn't enabled, the tool returns a 424 with an actionable install message. Full details + DQL syntax reference: [Companion plugin → Dataview](plugin.md#dataview).

> *"Use `dataview_query` to list every note tagged #book with its rating."*

### `base_query`

Evaluate an Obsidian Bases `.base` file and return its rows.

<!-- GENERATED:tool:base_query -->
| Arg | Type | Description |
|---|---|---|
| `file` | string? | Vault-relative path to a `.base` YAML file (e.g. "Bases/Books.base"). Either `file` or `yaml` is required. |
| `yaml` | string? | Inline `.base` YAML source. Either `file` or `yaml` is required. |
| `view` | string | The name of the view inside the `.base` file to execute, e.g. "active-books". |
| `timeoutMs` | number? | HTTP timeout in ms (default 30000). The plugin evaluator itself cannot be cancelled; this just bounds how long this tool waits. |
<!-- /GENERATED:tool:base_query -->

Response shape: `{view, rows, total, executedAt}` — `total` is the pre-limit count; `rows` each contain `{file: {name, path}, ...projected columns}` with Dates flattened to ISO strings.

Requires:

1. Companion plugin v1.6.0 (see [plugin.md](plugin.md)).
2. Obsidian ≥ 1.10.0.
3. The **Bases core plugin** enabled (Obsidian → Settings → Core plugins → Bases). Bases is first-party core Obsidian, not a community plugin.

Supported v1.4.0 expression subset: tree ops (`and` / `or` / `not`), comparisons (`==`, `!=`, `>`, `>=`, `<`, `<=`), leaf booleans (`&&`, `||`, `!`), `file.{name, path, folder, ext, size, mtime, ctime, tags}`, `file.hasTag(...)`, `file.inFolder(...)`, frontmatter dot-access. Arithmetic, method calls other than `hasTag`/`inFolder`, function calls (`today()`, `now()`, `date()`, `list()`, `link()`, `icon()`), regex literals, `formulas:`, `summaries:`, and `this` context all return 400 `unsupported_construct` errors — deferred to v1.4.1 / v1.4.2 / v1.4.3 patches. Full subset + error reference: [Companion plugin → Bases](plugin.md#bases).

> *"Use `base_query` on `Bases/Books.base` with view `active-books` to list everything I'm currently reading."*

## Maintenance

### `reindex`

Force a full re-index. You rarely need this — the live watcher picks up file changes automatically. Fall back to `reindex` if your vault lives somewhere FSEvents/inotify can't observe (SMB, NFS), or after bulk edits outside Claude. A bare `reindex({})` call defaults `resolution` to `1.0`, re-runs Louvain community detection, and prunes orphan stubs.

<!-- GENERATED:tool:reindex -->
| Arg | Type | Description |
|---|---|---|
| `resolution` | number? = 1 | Louvain resolution. Default 1.0 (equal-weight clusters). 0.5 = fewer/broader; 2.0 = more/finer. |
<!-- /GENERATED:tool:reindex -->

Response includes `stubsPruned: N` — the one-shot migration path for users upgrading from older versions with pre-fix orphan stubs.

> *"Use `reindex` to refresh the index after I bulk-edited files outside Claude."*

### `index_status`

Read-only inspection of index health. Added in v1.7.0 alongside fault-tolerant rebuild and adaptive capacity — surfaces everything an LLM client needs to answer "is semantic search working?" without mutating any state.

<!-- GENERATED:tool:index_status -->
| Arg | Type | Description |
|---|---|---|
<!-- /GENERATED:tool:index_status -->

Response fields:

- `embeddingModel`, `embeddingDim`, `provider` — active embedder identity.
- `notesTotal`, `notesWithEmbeddings`, `notesMissingEmbeddings`, `chunksTotal` — coverage counts.
- `chunksSkippedInLastRun`, `failedChunks[]`, `failedChunksTotal` — fault-tolerant skip-log (v1.7.0 `failed_chunks` table). Each `failedChunks` entry has `note`, `reason` (`too-long` / `embed-error`), `at` (epoch ms).
- `advertisedMaxTokens`, `discoveredMaxTokens` — capacity bounds (v1.7.0 `embedder_capability` table). `advertised` from the tokenizer / `/api/show`; `discovered` shrinks if embed failures reveal a tighter ceiling.
- `lastReindexReasons` — the bootstrap's stated reasons for any reindex on last boot (e.g. model switch, prefix-strategy version bump).
- `reindexInProgress` — boolean; true while a background reindex is running (v1.7.0 made this a reliable flag, previously an unreliable promise probe).
- `embedderReady`, `initError` — live ctx state; any startup failure surfaces in `initError` as `"Name: message"`.

> *"Use `index_status` to check whether semantic search is ready and see how many chunks were skipped in the last reindex."*

---

## Capability matrix

| Tool | Works offline | Needs plugin | Writes to vault |
|---|:-:|:-:|:-:|
| `search` | ✅ | — | — |
| `list_notes` | ✅ | — | — |
| `read_note` | ✅ | — | — |
| `find_connections` | ✅ | — | — |
| `find_path_between` | ✅ | — | — |
| `detect_themes` | ✅ | — | — |
| `rank_notes` | ✅ | — | — |
| `create_note` | ✅ | — | ✅ |
| `edit_note` | ✅ | — | ✅ |
| `apply_edit_preview` | ✅ | — | ✅ |
| `link_notes` | ✅ | — | ✅ |
| `move_note` | ✅ | — | ✅ |
| `delete_note` | ✅ | — | ✅ |
| `active_note` | — | ✅ | — |
| `dataview_query` | — | ✅ (v0.2.0+) + Dataview community plugin | — |
| `base_query` | — | ✅ (v1.6.0) + Obsidian ≥ 1.10.0 + Bases core plugin | — |
| `reindex` | ✅ | — | — |
| `index_status` | ✅ | — | — |
