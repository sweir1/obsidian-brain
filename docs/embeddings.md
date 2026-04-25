---
title: Embedding model
description: Pick a preset, pick a provider, or bring your own model — obsidian-brain handles the reindex automatically.
---

# Embedding model

> **Looking for the preset table or BYOM?** See [Models](models.md).

Embeddings are what make semantic search work — obsidian-brain converts each chunk of your notes into a vector and finds the closest matches when you search. The embedder is pluggable; you pick the trade-off between size, speed, and quality via one env var.

The easiest way to pick a model is `EMBEDDING_PRESET` — set it to a preset name instead of memorising Hugging Face model paths. `EMBEDDING_MODEL` still works for any custom checkpoint (power-user path; takes precedence when set). The server records the active model (and its output dim) in the index. If you switch models the next startup detects the change, drops the old vectors, and rebuilds per-chunk embeddings against the new model — no manual `--drop` required.

## Chunk-level embeddings

Embeddings are chunk-level — each note is split at markdown headings (H1–H4) and oversized sections are further split on paragraph / sentence boundaries, preserving code fences and `$$…$$` LaTeX blocks. SHA-256 content-hash dedup means unchanged chunks don't get re-embedded on incremental reindex.

The default `hybrid` search mode fuses chunk-level semantic rank and full-text BM25 rank via Reciprocal Rank Fusion (RRF), so you get both literal-token hits and concept matches out of the box.

## Multilingual / non-English vaults

Set one env var and restart. The multilingual path Just Works via transformers.js — no extra server, no Ollama:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault",
        "EMBEDDING_PRESET": "multilingual"
      }
    }
  }
}
```

This pulls `Xenova/multilingual-e5-small` (384-dim, 94 languages, ~135 MB one-time download = 118 MB ONNX + 17 MB tokenizer). The mandatory `query: ` / `passage: ` E5 prefixes are applied automatically per task type — you don't need to think about them. The auto-reindex triggers on next boot; incremental reindexes after that are imperceptibly different from the English presets thanks to SHA-256 content-hash dedup.

For preset quality comparisons and the Ollama-based multilingual option, see [Models](models.md#presets).

## Changing your embedding model

You can change `EMBEDDING_PRESET` or `EMBEDDING_MODEL` at any time. On the next server start, obsidian-brain detects the change, wipes the old embedding vectors, and re-embeds your vault against the new model in the background.

**What happens:**
1. The MCP handshake and tool listing complete immediately — the server is responsive from the first second.
2. Semantic search returns `{status: "preparing"}` during the re-embed.
3. Fulltext search and every non-semantic tool (list_notes, read_note, find_connections, rank_notes, graph tools, write tools) work throughout — only semantic `search` is affected.
4. Typical 3000-note vault re-embeds in 5–15 minutes depending on the new model's size.

**No manual cleanup needed.** The old vectors are dropped automatically. Index is eventually consistent.

**Check progress**: the `index_status` tool (v1.7.0) shows `chunksTotal`, `chunksSkippedInLastRun`, and `lastReindexReasons`. Call it from your MCP client to see "what's the current state of my index."

**Rolling back**: just change the env var back and restart. The previous model's vectors will be re-generated on next boot — same flow, reverse direction.

## Alternative provider: Ollama

Set `EMBEDDING_PROVIDER=ollama` to route every embed through a local [Ollama](https://ollama.com) server instead of transformers.js. Useful if you already run Ollama for LLMs and want to reuse its (usually higher-quality) embedding models.

| Provider | Best for | Quality | Setup |
|---|---|---|---|
| `transformers` (default) | Any machine, offline, zero setup | Good → Very Good | None |
| `ollama` | Users already running Ollama | Excellent (`nomic-embed-text`, `bge-large`, `mxbai-embed-large`) | Install Ollama + `ollama pull <model>` |

Minimal Ollama setup:

```bash
ollama pull nomic-embed-text         # or mxbai-embed-large, bge-large, etc.
export EMBEDDING_PROVIDER=ollama
export EMBEDDING_MODEL=nomic-embed-text
# Optional — skip the startup probe by declaring the dim up front:
export OLLAMA_EMBEDDING_DIM=768
```

Well-known dims: `nomic-embed-text` = 768, `mxbai-embed-large` = 1024, `bge-large` = 1024, `qwen3-embedding-8b` = 4096. If `OLLAMA_EMBEDDING_DIM` is unset the server probes the model on first startup.

The factory applies task-type prefixes automatically for asymmetric models — `nomic-embed-text` gets `search_query: ` / `search_document: `; `qwen*` embeddings get `Query: ` on the query side; `mxbai-embed-large` / `mixedbread*` get `Represent this sentence for searching relevant passages: ` on queries. No user action needed.

Switching provider (or model) triggers an auto-reindex on next boot — the server stores `ollama:<model>` in the index and rebuilds per-chunk embeddings against the new identifier. No `--drop` required.

For specific Ollama model recommendations and BYOM recipes, see [Models](models.md#bring-your-own-model-byom).
