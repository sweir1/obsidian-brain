---
title: Tool reference
description: All 15 obsidian-brain MCP tools, grouped by intent, with arguments and usage prompts.
---

# Tool reference

15 tools, grouped by intent. Every tool description below includes a one-line Claude prompt you can copy-paste into chat to nudge routing in the right direction.

Tools marked **requires companion plugin** only work when the [companion Obsidian plugin](plugin.md) is installed and Obsidian is running. Every other tool works standalone against the vault on disk.

## Find

### `search`

Find notes by meaning (semantic similarity over locally-embedded chunks) or by exact text (SQLite FTS5). The default `hybrid` mode fuses both rankings via Reciprocal Rank Fusion.

| Arg | Type | Description |
|---|---|---|
| `query` | string | Natural-language query or keyword phrase. |
| `mode` | `"hybrid"` \| `"semantic"` \| `"fts"` | Default `hybrid`. |
| `limit` | number | Default `10`. |
| `dir` | string | Restrict to a vault subdirectory. |
| `tag` | string | Restrict to notes tagged with this value. |

> *"Use `search` to find notes semantically about supply-chain tax."*

### `list_notes`

List notes, optionally filtered by directory, tag, or link-target status.

| Arg | Type | Description |
|---|---|---|
| `dir` | string | Restrict to subdirectory. |
| `tag` | string | Restrict to a tag. |
| `includeStubs` | boolean | Default `true`. Set `false` to exclude unresolved wiki-link targets. |
| `limit` | number | Default `100`. |

> *"Use `list_notes` to list every note under `Projects/` tagged `#active`."*

### `read_note`

Read a note's metadata (and optionally its full body). Fuzzy-matches filenames, so "Q4 planning" resolves to `Meetings/2025-Q4 planning.md` if unambiguous.

| Arg | Type | Description |
|---|---|---|
| `name` | string | Path, filename, or fuzzy match. |
| `includeBody` | boolean | Default `false` (metadata-only). |

> *"Use `read_note` to open the note called 'Q4 planning' and include the full content."*

## Map the graph

### `find_connections`

N-hop link neighborhood around a note. Returns inbound + outbound links grouped by hop distance, optionally the full subgraph for visualization.

| Arg | Type | Description |
|---|---|---|
| `note` | string | Starting note (path or fuzzy). |
| `hops` | number | Default `1`, max `3`. |
| `includeSubgraph` | boolean | Return all edges in the neighborhood. |

> *"Use `find_connections` to show everything within 2 hops of `Epistemology.md`."*

### `find_path_between`

Shortest link chain(s) between two notes. Optionally return their shared neighbors as well.

| Arg | Type | Description |
|---|---|---|
| `from` | string | Source note. |
| `to` | string | Target note. |
| `k` | number | Return up to `k` distinct shortest paths. Default `1`. |
| `includeSharedNeighbors` | boolean | Return notes both nodes link to. |

> *"Use `find_path_between` to find how `Bayesian updating` connects to `Kelly criterion`."*

### `detect_themes`

Auto-detected topic clusters via [Louvain community detection](https://en.wikipedia.org/wiki/Louvain_method) over the backlink graph. Returns clusters with member notes + a generated summary per cluster.

| Arg | Type | Description |
|---|---|---|
| `resolution` | number | Louvain resolution parameter. Default `1.0`. Higher = more, smaller clusters. |
| `minSize` | number | Drop clusters below this size. |

> *"Use `detect_themes` to surface the main themes across my vault."*

### `rank_notes`

Top notes by influence (PageRank over backlinks) or bridging (betweenness centrality).

| Arg | Type | Description |
|---|---|---|
| `method` | `"pagerank"` \| `"betweenness"` | Default `pagerank`. |
| `limit` | number | Default `10`. |

> *"Use `rank_notes` to list the top 10 most-linked-to notes by PageRank."*

## Write

### `create_note`

Create a new note with frontmatter and auto-index it. `title:` is auto-injected from the filename unless you explicitly pass `frontmatter: { title: null }`.

| Arg | Type | Description |
|---|---|---|
| `path` | string | Relative path under the vault, including `.md`. |
| `content` | string | Markdown body (exclude frontmatter). |
| `frontmatter` | object | YAML frontmatter key/value map. |
| `tags` | string[] | Convenience: tags written into `frontmatter.tags`. |

> *"Use `create_note` to create `Meetings/2026-04-21 standup.md` with tags `[meeting, standup]`."*

### `edit_note`

Modify an existing note. Six modes: `append`, `prepend`, `window` (character-level), `patch_heading`, `patch_frontmatter`, `at_line`.

| Arg | Type | Description |
|---|---|---|
| `name` | string | Path or fuzzy match. |
| `mode` | string | One of the six above. |
| `content` | string | New content (mode-dependent). |
| `heading` | string | Target heading (for `patch_heading`). |
| `scope` | `"section"` \| `"body"` | For `patch_heading`: `body` stops at the first blank line, `section` consumes until the next heading. Default `section`. |
| `line` | number | For `at_line`. |
| `key` / `value` / `valueJson` | | For `patch_frontmatter`. Use `valueJson` from clients that stringify tool params (e.g. `valueJson: 'null'` to clear). |

> *"Use `edit_note` to append a 'Follow-ups' section to today's standup note."*

### `link_notes`

Add a wiki-link between two notes plus a "why this connects" context sentence placed where the link is inserted.

| Arg | Type | Description |
|---|---|---|
| `from` | string | Source note. |
| `to` | string | Target note. |
| `context` | string | One-sentence explanation. |
| `section` | string | Heading under which to insert. Default `## Related`. |

> *"Use `link_notes` to link `Bayesian updating` to `Kelly criterion` with a note about risk-adjusted bets."*

### `move_note`

Rename or move a note. All inbound wiki-links are rewritten; graph edges stay intact.

| Arg | Type | Description |
|---|---|---|
| `from` | string | Current path. |
| `to` | string | New path. |

> *"Use `move_note` to move `Inbox/thought.md` into `Areas/Ideas/thought.md`."*

### `delete_note`

Delete a note. Requires `confirm: true` to actually execute — without it, returns a dry-run summary.

| Arg | Type | Description |
|---|---|---|
| `name` | string | Path or fuzzy match. |
| `confirm` | boolean | Must be `true` to actually delete. |

> *"Use `delete_note` with `confirm: true` to delete `Inbox/obsolete.md`."*

## Live editor

These tools **require the [companion plugin](plugin.md)** installed in your vault and Obsidian running.

### `active_note`

Returns the note currently open in Obsidian — path, cursor position, and selection range. Requires plugin v0.1.0+.

> *"Use `active_note` to see what note I'm editing right now."*

### `dataview_query`

Run a [Dataview](https://blacksmithgu.github.io/obsidian-dataview/) DQL query. Returns a normalised discriminated union:

- `kind: "table"` → `{ headers, rows }`
- `kind: "list"` → `{ values }`
- `kind: "task"` → `{ items: [...] }` with full STask fields
- `kind: "calendar"` → `{ events: [...] }`

All Dataview `Link` / `DateTime` / `DataArray` / `Duration` values are flattened to JSON so tools consuming the output don't need Dataview runtime types.

| Arg | Type | Description |
|---|---|---|
| `query` | string | DQL query (`TABLE ... FROM ...` etc.). |
| `timeoutMs` | number | Default `30000`. Bounds the HTTP wait only — Dataview has no cancellation API, so prefer `LIMIT N` for open-ended queries. |

Requires companion plugin v0.2.0+ and the [Dataview community plugin](https://obsidian.md/plugins?id=dataview) enabled in the vault. See [Companion plugin → Dataview](plugin.md#dataview) for the timeout caveat.

> *"Use `dataview_query` to list every note tagged #book with its rating."*

## Maintenance

### `reindex`

Force a full re-index. You rarely need this — the live watcher picks up file changes automatically. Fall back to `reindex` if your vault lives somewhere FSEvents/inotify can't observe (SMB, NFS), or after bulk edits outside Claude.

| Arg | Type | Description |
|---|---|---|
| `resolution` | number | Optional: also recompute Louvain communities at this resolution. Default `1.0`. |

> *"Use `reindex` to refresh the index after I bulk-edited files outside Claude."*

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
| `link_notes` | ✅ | — | ✅ |
| `move_note` | ✅ | — | ✅ |
| `delete_note` | ✅ | — | ✅ |
| `active_note` | — | ✅ | — |
| `dataview_query` | — | ✅ (v0.2.0+) | — |
| `reindex` | ✅ | — | — |
