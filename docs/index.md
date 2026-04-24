---
hide:
  - navigation
  - toc
render_macros: false
---

# obsidian-brain

**Semantic search + knowledge graph + vault editing** for Claude and any MCP client — over your Obsidian vault. Stdio-only, local embeddings, nothing hosted.

[Get started](getting-started.md){ .md-button .md-button--primary }
[Mac walkthrough (non-technical)](install-mac-nontechnical.md){ .md-button }
[GitHub](https://github.com/sweir1/obsidian-brain){ .md-button }

---

## Install in 60 seconds

**macOS one-liner** — automates Homebrew + Node + the `/usr/local/bin` symlinks + the Claude Desktop config merge + Full Disk Access:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/sweir1/obsidian-brain/main/scripts/install.sh)"
```

Already have Node 20+? Drop this into Claude Desktop's config file at `~/Library/Application Support/Claude/claude_desktop_config.json` instead:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

Quit Claude (⌘Q), relaunch. First boot auto-indexes your vault and downloads a small embedding model — usually under a minute. That's it.

[Config for Cursor, Claude Code, Jan, and 11 other clients →](install-clients.md){ .md-button }
[I'm not a developer — walk me through it →](install-mac-nontechnical.md){ .md-button }

---

## What you get

<div class="grid cards" markdown>

-   :material-magnify: __Find__

    ---

    Hybrid semantic + BM25 search over chunk-level embeddings, fused via Reciprocal Rank Fusion.

    `search` · `list_notes` · `read_note`

-   :material-graph-outline: __Map__

    ---

    PageRank, Louvain community detection, shortest-path between any two notes in your vault.

    `find_connections` · `find_path_between` · `detect_themes` · `rank_notes`

-   :material-pencil-outline: __Write__

    ---

    Dry-run previews, atomic bulk edits, safe `move_note` that preserves inbound links and chunk embeddings.

    `edit_note` · `create_note` · `move_note` · `link_notes` · `apply_edit_preview`

-   :material-shield-lock-outline: __Private by default__

    ---

    Stdio-only — no network listener, no API keys, no outbound requests. Local embeddings via transformers.js. Your vault content never leaves the machine.

-   :material-speedometer: __Fast__

    ---

    SQLite + FTS5 + sqlite-vec. Microsecond reads, incremental indexing via filesystem watcher, debounced writes.

-   :material-puzzle-remove-outline: __No plugin needed__

    ---

    Reads `.md` files directly off disk. Obsidian doesn't need to be running. The [companion plugin](plugin.md) is optional — only for live-editor features.

-   :material-heart-pulse: __Health & observability__

    ---

    Fault-tolerant indexing (one bad chunk never halts the rebuild) + read-only `index_status` tool for coverage, failed chunks, capacity bounds, and reindex state (v1.7.0).

    `index_status` · `reindex`

</div>

---

## Why not just use Local REST API?

- __Obsidian can be closed__ — obsidian-brain reads `.md` files directly off disk, not through the Obsidian runtime.
- __Nothing to install inside Obsidian__ for the core feature set.
- __Chunk-level semantic search__ — LRA has no embeddings.
- __Graph analytics__ (PageRank, Louvain community detection, shortest-path) — LRA has no graph layer.
- __Stdio-only__ — no HTTP server, no port conflicts, no firewall prompts, no transport bugs.

[Architecture deep-dive →](architecture.md) · [Tool reference →](tools.md) · [Changelog →](CHANGELOG.md)
