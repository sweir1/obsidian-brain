---
title: Quick start
description: Wire obsidian-brain into your MCP client in under a minute — no clone, no build.
---

# Quick start

No clone, no build. Requires **Node 20+** and an Obsidian vault (or any folder of `.md` files — Obsidian itself is optional).

## Minimum config

Wire obsidian-brain into your MCP client. Example for **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain", "server"],
      "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

Quit Claude Desktop (⌘Q on macOS) and relaunch. That's it.

For every other MCP client (Claude Code, Cursor, VS Code, Jan, Windsurf, Cline, Zed, LM Studio, Opencode, Codex, Gemini CLI, Warp, JetBrains AI), see [Install in your MCP client](install-clients.md).

## First boot

On first launch the server auto-indexes your vault and downloads the ~22 MB embedding model. Initial `tools/list` may block for **30–60 s** — subsequent starts are instant. See [Architecture → indexing](architecture.md) for why.

No system-level prerequisites beyond Node 20+. The `better-sqlite3`, `sqlite-vec`, and ONNX runtime native bindings ship as prebuilt binaries for macOS, Linux, and Windows — no `brew install sqlite`, no Xcode Command Line Tools, no Python required.

## Environment variables

All configuration is via environment variables. Only `VAULT_PATH` is required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | **yes** | — | Absolute path to the vault (folder of `.md` files). |
| `DATA_DIR` | no | `$XDG_DATA_HOME/obsidian-brain` or `$HOME/.local/share/obsidian-brain` | Where the SQLite index + embedding cache live. |
| `EMBEDDING_MODEL` | no | `Xenova/all-MiniLM-L6-v2` | Sentence-embedding checkpoint (any transformers.js-compatible model). Switching models triggers an automatic reindex — no `--drop` required. See [architecture](architecture.md) for the model-swap flow. |
| `OBSIDIAN_BRAIN_NO_WATCH` | no | unset | Set to `1` to disable the live watcher and fall back to scheduled re-indexing. |
| `OBSIDIAN_BRAIN_NO_CATCHUP` | no | unset | Set to `1` to disable the startup catchup reindex. |
| `OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS` | no | `3000` | Per-file reindex debounce for the watcher. |
| `OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS` | no | `60000` | Graph-wide community-detection debounce. |
| `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS` | no | `30000` | Per-tool-call timeout. |

`KG_VAULT_PATH` is accepted as a legacy alias for `VAULT_PATH`.

## Next steps

- Browse the [tool reference](tools.md) — 15 tools grouped by intent.
- Install the optional [companion plugin](plugin.md) to unlock `active_note` and `dataview_query`.
- Read [Architecture](architecture.md) for *why* stdio, SQLite, and local embeddings.
- If something goes wrong: [Troubleshooting](troubleshooting.md).
