---
title: Models
description: Preset catalogue + BYOM + license notes
---

# Models

> **Looking for pipeline architecture or chunking details?** See [Embedding model](embeddings.md).

## Presets

Use `EMBEDDING_PRESET` to choose a named model without memorising Hugging Face paths. The default preset is `english`.

| Preset | Model | Dim | Size | License | Notes |
|---|---|---|---|---|---|
| `english` *(default)* | `Xenova/bge-small-en-v1.5` | 384 | ~34 MB | MIT | English, asymmetric (`query:` / `passage:` prefixes applied automatically). Best retrieval under a ~60 MB budget. |
| `english-fast` | `Xenova/paraphrase-MiniLM-L3-v2` | 384 | ~17 MB | MIT | Smallest viable English preset. Symmetric. For constrained environments. |
| `english-quality` | `Xenova/bge-base-en-v1.5` | 768 | ~110 MB | MIT | Highest English CPU quality. Asymmetric. Over the default size budget but worth it when you have the RAM / disk. |
| `multilingual` | `Xenova/multilingual-e5-small` | 384 | ~135 MB | MIT | 94 languages. Asymmetric (E5 prefixes auto-applied). |
| `multilingual-quality` | `Xenova/multilingual-e5-base` | 768 | ~279 MB | MIT | Highest-quality multilingual preset via transformers.js (no Ollama needed) — but see [KNOWN ISSUES](#known-issues) below. Asymmetric. |
| `multilingual-ollama` | `bge-m3` (via Ollama) | 1024 | — | MIT | **Highest-quality multilingual preset.** 100+ languages, 8192-token context, best open multilingual embedder in 2026. Beats `multilingual-quality` by +6.77pp MTEB (0.7558 vs 0.6881) with 16× the context window. Requires Ollama + `ollama pull bge-m3`. |

Example MCP client config with a preset:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault",
        "EMBEDDING_PRESET": "multilingual-ollama"
      }
    }
  }
}
```

## Deprecated aliases

Two names from earlier releases are kept as aliases and emit a one-time stderr warning on boot:

| Alias | Resolves to | Change note |
|---|---|---|
| `fastest` | `english-fast` | Pure rename — same model (`Xenova/paraphrase-MiniLM-L3-v2`). |
| `balanced` | `english` | **Model changed.** Was `Xenova/all-MiniLM-L6-v2`; now resolves to `Xenova/bge-small-en-v1.5`. Vaults with `EMBEDDING_PRESET=balanced` re-embed once on upgrade to v1.7.0. To suppress the deprecation warning, set `EMBEDDING_PRESET=english` (identical behaviour, no warning). |

## Quality ranking

MTEB scores from the user's research. Higher is better. Preset names highlighted where applicable.

### English presets

| Model | Preset | MTEB eng avg |
|---|---|---|
| `onnx-community/embeddinggemma-300m-ONNX` | *(BYOM — v1.8.0 preset candidate)* | 0.6524 |
| `Alibaba-NLP/gte-modernbert-base` | *(BYOM — v1.8.0 preset candidate)* | 0.6421 |
| `jinaai/jina-embeddings-v5-text-nano` | *(BYOM — future)* | 0.6286 |
| `Xenova/bge-base-en-v1.5` | **`english-quality`** | 0.6138 |
| `Xenova/bge-small-en-v1.5` | **`english`** *(default)* | 0.5863 |
| `Xenova/paraphrase-MiniLM-L3-v2` | **`english-fast`** | — |

### Multilingual presets

| Model | Preset | MTEB multi avg |
|---|---|---|
| `intfloat/multilingual-e5-large-instruct` | *(BYOM — Ollama route)* | 0.7781 |
| `bge-m3` | **`multilingual-ollama`** | 0.7558 |
| `Xenova/multilingual-e5-base` | **`multilingual-quality`** | 0.6881 |
| `Xenova/multilingual-e5-small` | **`multilingual`** | — |

## Bring Your Own Model (BYOM)

The `EMBEDDING_MODEL` env var accepts any Hugging Face model id supported by transformers.js. Set `EMBEDDING_PROVIDER=transformers` (default) or `EMBEDDING_PROVIDER=ollama` depending on the model's available route.

```json
{
  "env": {
    "VAULT_PATH": "/path/to/vault",
    "EMBEDDING_MODEL": "Alibaba-NLP/gte-modernbert-base"
  }
}
```

**Pre-flight a model before committing:**

```bash
npx obsidian-brain models check Alibaba-NLP/gte-modernbert-base
```

`models check` downloads the model, loads it, and reports its output dim and detected prefix behaviour — without touching your live index.

**Other `models` subcommands:**

| Command | What it does |
|---|---|
| `models list` | Lists all built-in presets with model id, dim, and size |
| `models recommend` | Scans your vault and recommends `english` or `multilingual` |
| `models prefetch <id>` | Downloads ONNX weights without starting the server |
| `models check <id>` | Downloads + loads + reports dim and prefix behaviour |

**`EmbedderLoadError` kinds:**

| Kind | Cause | Fix |
|---|---|---|
| `not-found` | Model id doesn't exist on HF Hub | Check the model id — look under `Xenova/` for ONNX ports |
| `no-onnx` | Repo exists but has no ONNX weights | Use a Xenova port, or use Ollama for the model |
| `offline` | Network unavailable at load time | Ensure HF Hub is reachable, or pre-fetch with `models prefetch` |

### BYOM model catalogue

Models documented here are not built-in presets in v1.7.2 but can be used today (or in the near future) via BYOM configuration.

| Model | License | Route | MTEB eng | MTEB multi | Status |
|---|---|---|---|---|---|
| `jinaai/jina-embeddings-v5-text-nano` | CC-BY-NC-4.0 | — | 0.6286 | — | Future — no ONNX in official repo (GGUF only); Ollama support pending ([#14641](https://github.com/ollama/ollama/issues/14641)) |
| `intfloat/multilingual-e5-large-instruct` | MIT | Ollama (community) | — | 0.7781 | **Usable today** via Ollama |
| `Alibaba-NLP/gte-modernbert-base` | Apache-2.0 | transformers.js | 0.6421 | — | **Usable today**; will become `english-longctx` preset in v1.8.0 |
| `onnx-community/embeddinggemma-300m-ONNX` | Gemma Terms | transformers.js / Ollama | 0.6524 | — | **Usable today**; preset candidate for v1.8.0 |
| `onnx-community/mdbr-leaf-mt-ONNX` | Apache-2.0 | transformers.js | — | — | **Usable today**; best sub-30M on MTEB; preset upgrade candidate for v1.8.0 |

#### intfloat/multilingual-e5-large-instruct — exact recipe

Highest MTEB multilingual score (0.7781) in the catalogue. MIT licensed. No transformers.js ONNX port, but a community Ollama model works:

```bash
ollama pull qllama/multilingual-e5-large-instruct
```

Then configure obsidian-brain:

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/your/vault",
    "EMBEDDING_PROVIDER": "ollama",
    "EMBEDDING_MODEL": "qllama/multilingual-e5-large-instruct"
  }
}
```

#### jinaai/jina-embeddings-v5-text-nano — status

CC-BY-NC-4.0, 212M parameters, 8192-token context, MTEB eng 0.6286 (+6.9pp over `bge-base`). The official HF repo contains only GGUF weights — no ONNX — so it cannot be loaded via transformers.js. Ollama support is tracked at [ollama#14641](https://github.com/ollama/ollama/issues/14641) (open, no PR merged as of v1.7.2). **Not usable via either provider today.** Watch that issue for progress.

#### Alibaba-NLP/gte-modernbert-base — BYOM recipe

Apache-2.0, 149M parameters, 8192-token context, MTEB eng 0.6421 (+8.3pp over `bge-base`). ONNX weights are in the official repo; ModernBERT architecture is supported in transformers.js v3.7.0+.

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/your/vault",
    "EMBEDDING_MODEL": "Alibaba-NLP/gte-modernbert-base"
  }
}
```

This model will become the `english-longctx` first-class preset in v1.8.0.

#### onnx-community/embeddinggemma-300m-ONNX — BYOM recipe

Gemma Terms (permissive for embeddings), 308M parameters, MTEB eng 0.6524 (+9.3pp over `bge-base`, highest English score in this catalogue). ONNX weights available (fp32/q8/q4).

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/your/vault",
    "EMBEDDING_MODEL": "onnx-community/embeddinggemma-300m-ONNX"
  }
}
```

This model will become a first-class preset in v1.8.0.

#### onnx-community/mdbr-leaf-mt-ONNX — BYOM recipe

Apache-2.0, 23M parameters — the best sub-30M model on MTEB. ONNX weights available (fp32/q8/q4).

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/your/vault",
    "EMBEDDING_MODEL": "onnx-community/mdbr-leaf-mt-ONNX"
  }
}
```

Preset upgrade candidate for v1.8.0.

## Known issues

### multilingual-quality: token_type_ids bug

`Xenova/multilingual-e5-base` (the `multilingual-quality` preset) has a known pipeline mismatch in transformers.js ([#267](https://github.com/huggingface/transformers.js/issues/267), [#938](https://github.com/huggingface/transformers.js/issues/938)): notes longer than approximately 400 words trigger a `"Missing the following inputs: token_type_ids"` ONNX shape error. When this happens:

- The note-level embedding fails and is skipped.
- The failure is recorded in the `failed_chunks` table and surfaced via the `index_status` tool.
- Starting from v1.7.2, a stderr warning is emitted when `EMBEDDING_PRESET=multilingual-quality` is resolved, pointing to this issue.

**Impact**: users with multilingual vaults containing long notes will see those notes missing from semantic search results. The `index_status` tool will show a non-zero `failedChunksTotal`.

**Recommended workaround**: switch to `multilingual-ollama` (`bge-m3`), which does not have this limitation, handles 8192-token context, and scores +6.77pp higher on MTEB multilingual benchmarks.

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/your/vault",
    "EMBEDDING_PRESET": "multilingual-ollama"
  }
}
```

If you cannot run Ollama, `multilingual` (`Xenova/multilingual-e5-small`) is more tolerant of longer notes than `multilingual-quality` because its lower capacity means it hits the length limit less often in practice.

## Long-note handling

obsidian-brain splits notes at markdown headings (H1–H4) and further splits oversized sections on paragraph and sentence boundaries, preserving code fences and `$$…$$` LaTeX blocks. Notes of any length are handled correctly — you do not need to keep notes short for semantic search to work.

**Token budget** — the chunk size is capped at 90% of the model's advertised `model_max_length` (read from the tokenizer config). This leaves headroom for the task prefix and avoids silent truncation. For Ollama models the budget is derived from `/api/show`.

**TreeRAG parent-heading prefix** (v1.7.0, ACL 2025) — each chunk is prefixed with its nearest parent heading path before embedding (e.g. `"Project Alpha > Goals > Q2"`). This improves retrieval for multi-chunk notes by giving the embedder topical context that would otherwise be lost at chunk boundaries.

**Override the budget** — if you need a smaller or larger chunk window (e.g. for a model with a stale tokenizer config), set:

```json
{ "env": { "OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS": "512" } }
```

When set, this value overrides the tokenizer-derived budget entirely.

## When your embedder is full

Occasionally a chunk is too long for the model even after the budget calculation — for example, a single code block or table that cannot be split further. v1.7.0 handles this gracefully:

- **Skip + log, not recurse-halve** — the failing chunk is skipped and logged to stderr. obsidian-brain does not attempt to recursively halve the chunk; industry consensus (NAACL 2025) is that repeated halving produces incoherent sub-chunks with worse retrieval than skipping.
- **`failed_chunks` table** — every skipped chunk is recorded with its note path, chunk offset, and the error message. The table persists across restarts.
- **Visible via `index_status`** — the `index_status` MCP tool reports `chunksSkippedInLastRun` so you can see at a glance how many chunks were skipped and whether the count is growing.
- **Adaptive budget tightening** — each "too long" failure lowers the cached `discovered_max_tokens` value, so subsequent chunks aim for a smaller budget and the same failure is less likely to repeat.

If you see a non-zero `chunksSkippedInLastRun`, check the notes listed in `failed_chunks` — they typically contain unusually large code blocks or tables. Trimming them or setting `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS` to a smaller value resolves the issue.

## License catalogue

Quick reference for every model licensed in this document. obsidian-brain ships only model id strings, not weights — license obligations attach to the user who downloads from HF or Ollama.

| License | Models | Interpretation |
|---|---|---|
| MIT | `Xenova/bge-small-en-v1.5`, `Xenova/bge-base-en-v1.5`, `Xenova/paraphrase-MiniLM-L3-v2`, `Xenova/multilingual-e5-small`, `Xenova/multilingual-e5-base`, `bge-m3`, `intfloat/multilingual-e5-large-instruct` | Permissive. Commercial use, modification, and distribution allowed with attribution. No copyleft. |
| Apache-2.0 | `Alibaba-NLP/gte-modernbert-base`, `onnx-community/mdbr-leaf-mt-ONNX` | Permissive. Commercial use allowed. Patent grant included. Attribution required in distributed copies. |
| CC-BY-NC-4.0 | `jinaai/jina-embeddings-v5-text-nano` | Non-commercial only without a separate commercial licence from Jina AI. obsidian-brain does not redistribute weights; the user accepts this licence when downloading from HF. |
| Gemma Terms | `onnx-community/embeddinggemma-300m-ONNX` | Google's Gemma licence. Permissive for most uses including personal and commercial embedding workloads; redistribution of model weights requires attribution and compliance with Gemma's acceptable use policy. |
