---
title: Quick start
description: Install obsidian-brain in under a minute — no clone, no build. Node 20+ and a folder of .md files is all you need.
---

# Quick start

No clone, no build. Requires **Node 20+** and an Obsidian vault (or any folder of `.md` files — Obsidian itself is optional).

!!! tip "Preflight check"
    You need Node 20+. Run `node -v` in Terminal — if it prints `v20.x.x` or higher, you're good. If it errors or shows an older version, the [macOS walkthrough](install-mac-nontechnical.md) covers the install.

## Minimum config

Wire obsidian-brain into your MCP client. Example for **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Quit Claude Desktop (⌘Q on macOS) and relaunch. That's it.

For every other MCP client (Claude Code, Cursor, VS Code, Jan, Windsurf, Cline, Zed, LM Studio, Opencode, Codex, Gemini CLI, Warp, JetBrains AI), see [Install in your MCP client](install-clients.md).

## First boot

On first launch the server auto-indexes your vault and downloads the default embedding model (`Xenova/bge-small-en-v1.5` via preset `english`, ~34 MB). Initial `tools/list` may block for **30–60 s** — subsequent starts are instant. See [Architecture → indexing](architecture.md) for why.

Per-model metadata (output dim, max tokens, query / document prefix) for canonical presets is bundled inside the npm tarball at `data/seed-models.json` (refreshed at every release from MTEB's curated registry). For BYOM models (`EMBEDDING_MODEL=any/hf-id`) the server fetches metadata from HuggingFace once on first use and caches it per-vault forever (invalidate via `obsidian-brain models refresh-cache`). See [Models → How model metadata is resolved](models.md#how-model-metadata-is-resolved).

No system-level prerequisites beyond Node 20+. The `better-sqlite3`, `sqlite-vec`, and ONNX runtime native bindings ship as prebuilt binaries for macOS, Linux, and Windows — no `brew install sqlite`, no Xcode Command Line Tools, no Python required.

## Environment variables

All configuration is via environment variables. Only `VAULT_PATH` is required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | **yes** | — | Absolute path to the vault (folder of `.md` files). |
| `DATA_DIR` | no | `$XDG_DATA_HOME/obsidian-brain` or `$HOME/.local/share/obsidian-brain` | Where the SQLite index + embedding cache live. |
| `EMBEDDING_PRESET` | no | `english` | Preset name. Options: `english` (default), `english-fast`, `english-quality`, `multilingual`, `multilingual-quality`, `multilingual-ollama`. See [Models](models.md) for the full table. Ignored if `EMBEDDING_MODEL` is set. |
| `EMBEDDING_MODEL` | no | *(resolved from preset)* | Power-user override: any transformers.js checkpoint (with `EMBEDDING_PROVIDER=transformers`) or Ollama model name (with `EMBEDDING_PROVIDER=ollama`). Takes precedence over `EMBEDDING_PRESET`. Switching models (or providers) triggers an automatic reindex on next boot — no `--drop` required. |
| `EMBEDDING_PROVIDER` | no | `transformers` | Embedder backend: `transformers` (local, zero setup) or `ollama` (routes through a local Ollama server via `/api/embeddings`). |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434` | Only read when `EMBEDDING_PROVIDER=ollama`. |
| `OLLAMA_EMBEDDING_DIM` | no | unset | Declared output dim for the Ollama model. If unset, the server probes the model on first startup. |
| `OLLAMA_NUM_CTX` | no | `8192` | Override Ollama's `num_ctx` for embed requests. Ollama's own default is 2048, which silently truncates long chunks on models trained for more (nomic-embed-text 8192, bge-m3 8192, qwen3-embedding:0.6b 32 768). |
| `OBSIDIAN_BRAIN_NO_WATCH` | no | unset | Set to `1` to disable the live watcher and fall back to scheduled re-indexing. |
| `OBSIDIAN_BRAIN_NO_CATCHUP` | no | unset | Set to `1` to disable the startup catchup reindex. |
| `OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS` | no | `3000` | Per-file reindex debounce for the watcher. |
| `OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS` | no | `60000` | Graph-wide community-detection debounce. |
| `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS` | no | `30000` | Per-tool-call timeout. |
| `OBSIDIAN_BRAIN_DEBUG` | no | unset | Set to `1` for a verbose synchronous startup trace on stderr — every preflight, createContext, server.connect, and shutdown step is logged with a monotonic timestamp. The last line before any silent failure pinpoints exactly which step the server reached. No-op when unset (zero output, zero overhead). Diagnostic-only — leave unset under normal use. |

`KG_VAULT_PATH` is accepted as a legacy alias for `VAULT_PATH`.

This table covers the knobs typical users need. For the full reference (including `OBSIDIAN_BRAIN_CONFIG_DIR`, `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS`, etc.) see [Configuration](configuration.md).

## Next steps

- Browse the [tool reference](tools.md) — 18 tools grouped by intent.
- Install the optional [companion plugin](plugin.md) to unlock `active_note`, `dataview_query`, and `base_query`.
- Read [Architecture](architecture.md) for *why* stdio, SQLite, and local embeddings.
- See [Configuration](configuration.md) for the full environment-variable reference.
- See [Models](models.md) for the preset table, MTEB rankings, license catalogue, and BYOM recipes.
- See [How embeddings work](embeddings.md) for the conceptual overview (chunk-level embeddings, adaptive budget, multilingual / Ollama setup).
- If something goes wrong: [Troubleshooting](troubleshooting.md).
