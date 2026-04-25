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

**Empty / frontmatter-only notes.** Daily notes (`# 2026-04-25` only), frontmatter-only metadata notes, embeds-only collector notes, and any note shorter than `minChunkChars` after stripping frontmatter would otherwise produce zero chunks. The indexer synthesises a fallback chunk from `title + tags + scalar frontmatter values + first 5 wikilink/embed targets` so these notes stay searchable by name. Notes with literally nothing to embed (no title, no frontmatter, no body) are recorded once in `failed_chunks` with reason `no-embeddable-content` and skipped permanently — surfaced as a distinct bucket in `index_status` so the count of "missing embeddings" reflects only genuine failures, not the daily-note tail.

## Adaptive chunk-size budget

Chunk size is bounded by the active embedder's max input length (`model_max_length` from the loaded tokenizer / `/api/show` for Ollama / the bundled seed for canonical presets). The chunker aims for `floor(0.9 × min(advertised, discovered))` tokens per chunk so a tail of long sentences won't push individual chunks over the model's hard cap.

If a chunk does fail to embed with a "too long" error, the fault-tolerant loop records it in `failed_chunks` and ratchets `discovered_max_tokens` down by half so subsequent chunks aim smaller. Two safeguards on top:

- **Floor at `MIN_DISCOVERED_TOKENS=256`** (clamped to advertised for tinier models) so a single freak chunk failure can no longer halve the budget down into single-sentence territory. Below 256 tokens, chunks are too small to carry meaningful semantic context — the floor preserves search quality.
- **Reset on every full reindex.** `discovered_max_tokens` is wiped back to advertised at the top of `IndexPipeline.index()` so cross-boot drift can't accumulate. Each full reindex starts from the model's full advertised limit.

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

**Check progress**: the `index_status` tool reports `notesWithEmbeddings` / `notesNoEmbeddableContent` / `notesMissingEmbeddings` (three buckets so you can tell intentional empty-note skips from real failures), plus `chunksTotal`, `chunksSkippedInLastRun`, `lastReindexReasons`, and a one-line `summary`. Call it from your MCP client to see "what's the current state of my index."

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
