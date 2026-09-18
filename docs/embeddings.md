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

For preset quality comparisons and the Ollama- and llama.cpp-based multilingual options, see [Models](models.md#presets).

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
| `openai-compatible` | Users already running llama.cpp / LM Studio / vLLM | Excellent (any GGUF or HF embedding model) | Point at a server you already run |

Minimal Ollama setup:

```bash
ollama pull nomic-embed-text         # or mxbai-embed-large, bge-large, etc.
export EMBEDDING_PROVIDER=ollama
export EMBEDDING_MODEL=nomic-embed-text
# Optional — skip the startup probe by declaring the dim up front:
export OLLAMA_EMBEDDING_DIM=768
```

!!! note "Auto-pull on first boot"
    Bare model ids like `nomic-embed-text` and `qwen3-embedding:0.6b` (Ollama's official `library/` namespace) auto-pull when the server first boots, so the `ollama pull` step above is technically optional for those. **Third-party namespaces** (`user/custom-fork`, `myregistry.com/team/model`) require `OBSIDIAN_BRAIN_OLLAMA_BYOM_AUTO_PULL=1` to opt in — this is a security default, since Ollama has no built-in trust gate for crafted manifests (CVE-2024-37032). Full allowlist table + escape hatches in [Models → BYOM Ollama auto-pull](models.md#byom-ollama-auto-pull-allowlist-opt-in).

Well-known dims: `nomic-embed-text` = 768, `mxbai-embed-large` = 1024, `bge-large` = 1024, `qwen3-embedding-8b` = 4096. If `OLLAMA_EMBEDDING_DIM` is unset the server probes the model on first startup.

The resolver chain (override → cache → seed → HF → embedder probe → fallback) supplies authoritative query/document prefixes — the canonical `multilingual-ollama` preset (`qwen3-embedding:0.6b`) ships its instruction-aware query prompt from the seed, and BYOM Ollama models inherit prefixes via the same chain. As a fallback (init-time probe before the resolver runs, plus tests), `OllamaEmbedder.getPrefix` applies family heuristics: `nomic-embed-text` gets `search_query: ` / `search_document: `; `e5-` gets `query: ` / `passage: `; `qwen` gets `Query: `; `mxbai-embed-large` / `mixedbread*` get `Represent this sentence for searching relevant passages: ` on queries. No user action needed.

Switching provider (or model) triggers an auto-reindex on next boot — the server stores `ollama:<model>` in the index and rebuilds per-chunk embeddings against the new identifier. No `--drop` required.

For specific Ollama model recommendations and BYOM recipes, see [Models](models.md#bring-your-own-model-byom).

## Alternative provider: llama.cpp and other OpenAI-compatible servers

Set `EMBEDDING_PROVIDER=llamacpp` to route every embed through a server speaking
`POST /v1/embeddings`. That one protocol covers
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`,
[LM Studio](https://lmstudio.ai), [vLLM](https://docs.vllm.ai),
[text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference),
LocalAI and OpenAI itself.

!!! info "The provider name is the protocol, not the vendor"
    The canonical value is `openai-compatible`, and **nothing leaves your machine**
    unless you point `EMBEDDING_BASE_URL` at a hosted endpoint. These aliases are
    all accepted and equivalent: `openai-compatible`, `openai`, `llamacpp`,
    `llama.cpp`, `lmstudio`, `vllm`, `tei`.

This is the path to run **GGUF quantised** embedding models, which the other two
providers can't: transformers.js needs ONNX weights, and Ollama needs its own
manifest format. If you already have a llama.cpp build for local LLMs, you have
everything you need.

### Minimal setup

Start the server:

```bash
llama-server -m Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embedding --pooling last -c 8192 -ub 8192 --port 8080
```

!!! warning "`--pooling last` is required for Qwen3-Embedding"
    That family pools on the **final token**, not the mean. Omitting the flag
    yields vectors that look fine — correct shape, unit norm, no error anywhere —
    but encode the wrong thing, so retrieval quality degrades silently. `-ub`
    must be ≥ `-c`: llama.cpp requires the micro-batch to hold the whole
    sequence when pooling is enabled.

Then point obsidian-brain at it:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault",
        "EMBEDDING_PRESET": "multilingual-openai",
        "EMBEDDING_PROVIDER": "llamacpp",
        "EMBEDDING_BASE_URL": "http://127.0.0.1:8080"
      }
    }
  }
}
```

The `multilingual-openai` preset resolves to `Qwen/Qwen3-Embedding-0.6B` — the
same weights as `multilingual-ollama`, keyed by the Hugging Face id so the
bundled seed supplies its instruction-aware query prefix and 32 768-token
context automatically.

### Naming the model matters, even though the server ignores it

An OpenAI-compatible embedding server generally serves exactly **one** model and
ignores the request's `model` field — llama.cpp returns whatever GGUF it loaded
regardless. So `EMBEDDING_MODEL` here is a **label**, not a selector.

It still matters, because it's the key the resolver chain looks up prefixes and
max-tokens under. Naming the real checkpoint is what makes asymmetric models
behave:

```bash
# Good — the seed has this id, so the Instruct:/Query: prefix applies.
export EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B

# Works, but the resolver finds nothing: falls back to a family heuristic.
export EMBEDDING_MODEL=my-local-gguf
```

### Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDING_BASE_URL` | `http://localhost:8080` | Server address. A trailing `/v1` is stripped, so both spellings work. |
| `EMBEDDING_DIM` | *(probed)* | Declare the dimensionality to skip the one throwaway probe embed at startup. |
| `EMBEDDING_API_KEY` | *(none)* | Bearer token. Leave unset for a local server. |

Well-known dims: `Qwen3-Embedding-0.6B` = 1024, `-4B` = 2560, `-8B` = 4096,
`bge-m3` = 1024.

### What this provider does and doesn't do

Unlike Ollama, the OpenAI protocol carries no metadata or model-management
surface, so a few things degrade — all deliberately, and none of them fatal:

- **No auto-pull.** The server owns its weights; you download the GGUF yourself.
- **`dimensions()` is probed**, by spending one throwaway embed during startup,
  unless `EMBEDDING_DIM` declares it. There is no endpoint to ask.
- **Context window and change-detection come from llama.cpp's `/props`**, which
  is an extension, not part of the protocol. On servers without it, obsidian-brain
  falls back to its own defaults rather than erroring. Note that the value
  reported is the server's `-c`, i.e. what it will *accept* — which is the right
  number for chunk budgeting, since a 32 k-token chunk fails against a server
  booted with `-c 8192` no matter what the checkpoint supports.
- **Vectors are re-normalised client-side** if the server didn't. llama.cpp
  L2-normalises by default; the protocol doesn't require it, and the search path
  compares with a plain dot product.

Switching provider triggers an auto-reindex on next boot — the index stores
`openai:<model>` as the identifier. Because that label stays constant when you
restart the server with a *different* GGUF, obsidian-brain also fingerprints the
served weights via `/props` (`model_path` + `build_info`) and reindexes when that
changes. Swapping the model out from under a running index is the most likely
silent-drift path for this provider, and that's the guard against it.

**Next:** the [Models](models.md) reference page for the full preset table, MTEB rankings, license catalogue, and BYOM recipes.
