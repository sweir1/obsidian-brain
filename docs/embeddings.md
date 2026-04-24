---
title: Embedding model
description: Pick a preset, pick a provider, or bring your own model — obsidian-brain handles the reindex automatically.
---

# Embedding model

Embeddings are what make semantic search work — obsidian-brain converts each chunk of your notes into a vector and finds the closest matches when you search. The embedder is pluggable; you pick the trade-off between size, speed, and quality via one env var.

The easiest way to pick a model is `EMBEDDING_PRESET` — set it to a preset name instead of memorising Hugging Face model paths. `EMBEDDING_MODEL` still works for any custom checkpoint (power-user path; takes precedence when set). The server records the active model (and its output dim) in the index. If you switch models the next startup detects the change, drops the old vectors, and rebuilds per-chunk embeddings against the new model — no manual `--drop` required.

## Presets

Use `EMBEDDING_PRESET` to choose a named model without memorising Hugging Face paths. The default preset is `english`, which resolves to `Xenova/bge-small-en-v1.5` (via preset `english`).

Example MCP client config with a preset:

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

### Available models

| Tier | Model | Dim | Size | Notes |
|---|---|---|---|---|
| **Default (≤60 MB)** | `Xenova/bge-small-en-v1.5` | 384 | ~34 MB | Default (`english` preset). English, asymmetric. Best retrieval under budget. |
| Default-tier alt | `Xenova/paraphrase-MiniLM-L3-v2` | 384 | ~17 MB | Tiny. English, symmetric. For constrained environments. |
| Default-tier alt | `Xenova/all-MiniLM-L12-v2` | 384 | ~34 MB | English, symmetric. More depth than L6 at similar size. |
| Default-tier alt | `Xenova/jina-embeddings-v2-small-en` | 512 | ~33 MB | English, symmetric. Long-context friendly. |
| Power-user (over budget) | `Xenova/bge-base-en-v1.5` | 768 | ~110 MB | Best CPU quality, but above the default size budget. |
| **Multilingual** (over budget) | `Xenova/multilingual-e5-small` | 384 | ~135 MB | 94 languages. Set `EMBEDDING_PRESET=multilingual` and restart — auto-reindexes. Above the 60 MB default-tier budget but still purely local. |

### Chunk-level embeddings

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

Rough speed numbers (single M1/M2 Mac, CPU-only, per chunk):

| Preset | Approx. embed latency | 3k-note vault initial index | Model download |
|---|---|---|---|
| `fastest` / `balanced` / `english` | ~30–60 ms / chunk | ~10–20 min | 17–34 MB, under a minute |
| `multilingual` | ~60–150 ms / chunk | ~30–50 min | ~135 MB, 1–3 min on 10 Mbps |

### Advanced: multilingual via Ollama

If you already run [Ollama](https://ollama.com) and want a higher-quality multilingual model (at the cost of a running server), pull one and flip the provider:

```bash
ollama pull bge-m3              # or: nomic-embed-text, multilingual-e5-large
export EMBEDDING_PROVIDER=ollama
export EMBEDDING_MODEL=bge-m3
```

`bge-m3` covers 100+ languages with dense + sparse + multi-vector heads. Model storage is out-of-band (not part of the npm install). Asymmetric query prefixing is still handled automatically.

## Changing your embedding model

You can change `EMBEDDING_PRESET` or `EMBEDDING_MODEL` at any time. On the next server start, obsidian-brain detects the change, wipes the old embedding vectors, and re-embeds your vault against the new model in the background.

**What happens:**
1. The MCP handshake and tool listing complete immediately — the server is responsive from the first second.
2. Semantic search returns `{status: "preparing"}` during the re-embed.
3. Fulltext search and every non-semantic tool (list_notes, read_note, find_connections, rank_notes, graph tools, write tools) work throughout — only semantic `search` is affected.
4. Typical 3000-note vault re-embeds in 5–15 minutes depending on the new model's size.

**No manual cleanup needed.** The old vectors are dropped automatically. Index is eventually consistent.

**Check progress**: the `index_status` tool (v1.7.0) shows `chunksOk` / `chunksSkipped` / the last reindex's reason. Call it from your MCP client to see "what's the current state of my index."

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
