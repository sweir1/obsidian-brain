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
| `english` *(default)* | `Xenova/bge-small-en-v1.5` | 384 | ~34 MB | MIT | English, asymmetric (BGE-style — `Represent this sentence for searching relevant passages: ` on queries; empty on documents — applied automatically). Best retrieval under a ~60 MB budget. |
| `english-fast` | `MongoDB/mdbr-leaf-ir` | 768 | ~22 MB | Apache-2.0 | Retrieval-tuned 23M-param distillation of `mxbai-embed-large-v1` (Matryoshka student). Asymmetric — `Represent this sentence for searching relevant passages: ` query prefix applied automatically. Sister model `MongoDB/mdbr-leaf-mt` is for general/clustering; `-ir` is what we wire here for RAG. v1.7.4: replaced `Xenova/paraphrase-MiniLM-L3-v2`. |
| `english-quality` | `Xenova/bge-base-en-v1.5` | 768 | ~110 MB | MIT | Highest English CPU quality. Asymmetric. Over the default size budget but worth it when you have the RAM / disk. |
| `multilingual` | `Xenova/multilingual-e5-small` | 384 | ~135 MB | MIT | 94 languages. Asymmetric (E5 prefixes auto-applied). |
| `multilingual-quality` | `Xenova/multilingual-e5-base` | 768 | ~279 MB | MIT | Highest-quality multilingual preset via transformers.js (no Ollama needed) — but see [KNOWN ISSUES](#known-issues) below. Asymmetric. |
| `multilingual-ollama` | `qwen3-embedding:0.6b` (via Ollama) | 1024 | ~600 MB | Apache-2.0 | **Highest-quality multilingual preset.** 100+ languages, 32 768-token context, instruction-aware retrieval. Beats `multilingual-quality` by +5.3pp MTEB-multilingual (64.3 vs 59.0) with 64× the context window. Requires Ollama + `ollama pull qwen3-embedding:0.6b`. |

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

## Quality ranking

MTEB scores from the user's research. Higher is better. Preset names highlighted where applicable.

### English presets

| Model | Preset | MTEB eng avg |
|---|---|---|
| `onnx-community/embeddinggemma-300m-ONNX` | *(BYOM — v1.8.0 preset candidate)* | 0.6524 |
| `Alibaba-NLP/gte-modernbert-base` | *(BYOM — v1.8.0 preset candidate)* | 0.6421 |
| `jinaai/jina-embeddings-v5-text-nano` | *(BYOM — future)* | 0.6286 |
| `Xenova/bge-base-en-v1.5` | **`english-quality`** | 0.6138 |
| `MongoDB/mdbr-leaf-ir` | **`english-fast`** | retrieval-tuned, distilled from `mxbai-embed-large-v1` |
| `Xenova/bge-small-en-v1.5` | **`english`** *(default)* | 0.5863 |

### Multilingual presets

| Model | Preset | MTEB multi avg |
|---|---|---|
| `Qwen/Qwen3-Embedding-0.6B` | **`multilingual-ollama`** | 64.33 |
| `BAAI/bge-m3` | *(BYOM — Ollama route, `ollama pull bge-m3`)* | 59.56 |
| `intfloat/multilingual-e5-large-instruct` | *(BYOM — Ollama route)* | — |
| `Xenova/multilingual-e5-base` | **`multilingual-quality`** | 59.0 |
| `Xenova/multilingual-e5-small` | **`multilingual`** | — |

## How model metadata is resolved

Per-model metadata (output dim, max tokens, query / document prefix) is resolved through a 6-step layered chain so canonical presets are zero-network and BYOM models still get the correct prefix without you declaring anything:

0. **User overrides** — `~/.config/obsidian-brain/model-overrides.json`, managed via `npx obsidian-brain models add <id> …` and `models override <id> …`. Topmost layer; survives `npm update`. When a user override fully specifies all three load-bearing fields (`maxTokens`, `queryPrefix`, `documentPrefix`), the resolver short-circuits the rest of the chain entirely — no HF round-trip on first use.
1. **Hot cache** — `embedder_capability` table in your vault DB. **Lives forever** once written; the cached fields are immutable for a given HF id. Invalidate explicitly with `npx obsidian-brain models refresh-cache` (or `--model <id>` for one entry) when you want to pick up an upstream config correction.
2. **Bundled seed** — `data/seed-models.json` shipped in the npm tarball. Regenerated at every release from MTEB's Python registry (zero HF API calls). Covers ~348 dense, text-only, open-weights embedding models — every canonical preset plus every popular community model. Cache miss + seed hit copies the seed entry into the cache (one-time; subsequent boots are cache hits). A user-fetched copy at `~/.config/obsidian-brain/seed-models.json` (managed via `models fetch-seed`) takes priority when present, so users can pull MTEB fixes without waiting for an npm release.
3. **Live HF fetch** — for BYOM models not in the seed, `getEmbeddingMetadata(modelId)` reads `config.json` + `tokenizer_config.json` + `sentence_bert_config.json` + `config_sentence_transformers.json` + `modules.json` in parallel, plus the upstream `base_model`'s same JSON when the direct repo lacks `prompts`. 5s timeout, 2 retries with backoff.
4. **Embedder probe + safe defaults** — if HF is unreachable, dim is probed from the loaded ONNX pipeline; max-tokens defaults to 512; symmetry assumed. Stderr warning surfaces the degraded state. Boot continues.

This replaces three hardcoded tables that previously lived in the codebase (a `getTransformersPrefix` family-pattern if/else, a `KNOWN_MAX_TOKENS` validation map, and `dim / symmetric / sizeMb / lang` columns on `EMBEDDING_PRESETS`). Wrong-prefix bugs become impossible because upstream HF configs are now the source of truth, not us.

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

`models check` goes directly to the live HuggingFace API (skipping the cache + seed chain — always fresh) (~2s, no model download). Reports dim, max tokens, query / document prefix, prefix source, base model, and ONNX size. Add `--load` to also download + load the ONNX weights for end-to-end validation (~30s).

**Other `models` subcommands** (full reference in [CLI](cli.md)):

| Command | What it does |
|---|---|
| `models list [--all] [--filter <q>]` | Lists the 6 presets by default. `--all` surfaces every entry in the bundled seed (~348 models). `--filter` narrows by id substring. Zero network calls. |
| `models recommend` | Scans your vault and recommends `english` or `multilingual` based on non-Latin character ratio |
| `models prefetch [preset]` | Downloads ONNX weights for a preset's model so first `index` doesn't pay download cost |
| `models check <id>` | Fetches HF metadata directly (~2s). Skips the cache/seed chain — always live HF. Add `--load` to also download + load. |
| `models add <id>` | Register a new model not in the seed (writes to `~/.config/obsidian-brain/model-overrides.json`). Refuses if id already in seed or overrides |
| `models override <id>` | Patch fields on an existing model id (writes to overrides file). Survives `npm update`. `--list` dumps every override; `--remove [--field name]` clears |
| `models fetch-seed` | Download latest seed from `main` branch on GitHub. Bypasses npm-release wait. Schema-version-aware |
| `models refresh-cache [--model <id>]` | Invalidate cached metadata. Cheap (~0 HF calls for seeded models). Does NOT require `VAULT_PATH` |

**`EmbedderLoadError` kinds:**

| Kind | Cause | Fix |
|---|---|---|
| `not-found` | Model id doesn't exist on HF Hub | Check the model id — look under `Xenova/` for ONNX ports |
| `no-onnx` | Repo exists but has no ONNX weights | Use a Xenova port, or use Ollama for the model |
| `offline` | Network unavailable at load time | Ensure HF Hub is reachable, or pre-fetch with `models prefetch` |

### BYOM model catalogue

Models documented here are not built-in presets but can be used today (or in the near future) via BYOM configuration.

| Model | License | Route | MTEB eng | MTEB multi | Status |
|---|---|---|---|---|---|
| `jinaai/jina-embeddings-v5-text-nano` | CC-BY-NC-4.0 | — | 0.6286 | — | Future — no ONNX in official repo (GGUF only); Ollama support pending ([#14641](https://github.com/ollama/ollama/issues/14641)) |
| `intfloat/multilingual-e5-large-instruct` | MIT | Ollama (community) | — | 0.7781 | **Usable today** via Ollama |
| `Alibaba-NLP/gte-modernbert-base` | Apache-2.0 | transformers.js | 0.6421 | — | **Usable today**; planned to become `english-longctx` preset in a future release |
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

CC-BY-NC-4.0, 212M parameters, 8192-token context, MTEB eng 0.6286 (+6.9pp over `bge-base`). The official HF repo contains only GGUF weights — no ONNX — so it cannot be loaded via transformers.js. Ollama support is tracked at [ollama#14641](https://github.com/ollama/ollama/issues/14641). **Not usable via either provider today.** Watch that issue for progress.

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

This model is planned to become the `english-longctx` first-class preset in a future release.

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

This model is planned to become a first-class preset in a future release.

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

Preset upgrade candidate for a future release.

## Known issues

### multilingual-quality: token_type_ids bug

`Xenova/multilingual-e5-base` (the `multilingual-quality` preset) has a known pipeline mismatch in transformers.js ([#267](https://github.com/huggingface/transformers.js/issues/267), [#938](https://github.com/huggingface/transformers.js/issues/938)): notes longer than approximately 400 words trigger a `"Missing the following inputs: token_type_ids"` ONNX shape error. When this happens:

- The note-level embedding fails and is skipped.
- The failure is recorded in the `failed_chunks` table and surfaced via the `index_status` tool.
- A stderr warning is emitted when `EMBEDDING_PRESET=multilingual-quality` is resolved, pointing to this issue.

**Impact**: users with multilingual vaults containing long notes will see those notes missing from semantic search results. The `index_status` tool will show a non-zero `failedChunksTotal`.

**Recommended workaround**: switch to `multilingual-ollama` (`qwen3-embedding:0.6b`), which does not have this limitation, handles 32 768-token context, and scores +5.3pp higher on MTEB multilingual benchmarks.

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

**TreeRAG parent-heading prefix** (ACL 2025) — each chunk is prefixed with its nearest parent heading path before embedding (e.g. `"Project Alpha > Goals > Q2"`). This improves retrieval for multi-chunk notes by giving the embedder topical context that would otherwise be lost at chunk boundaries.

**Override the budget** — if you need a smaller or larger chunk window (e.g. for a model with a stale tokenizer config), set:

```json
{ "env": { "OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS": "512" } }
```

When set, this value overrides the tokenizer-derived budget entirely.

## When your embedder is full

Occasionally a chunk is too long for the model even after the budget calculation — for example, a single code block or table that cannot be split further. The fault-tolerant indexer handles this gracefully:

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
| Apache-2.0 | `Alibaba-NLP/gte-modernbert-base`, `MongoDB/mdbr-leaf-ir`, `MongoDB/mdbr-leaf-mt`, `onnx-community/mdbr-leaf-mt-ONNX`, `Qwen/Qwen3-Embedding-0.6B`, `qwen3-embedding:0.6b` | Permissive. Commercial use allowed. Patent grant included. Attribution required in distributed copies. |
| CC-BY-NC-4.0 | `jinaai/jina-embeddings-v5-text-nano` | Non-commercial only without a separate commercial licence from Jina AI. obsidian-brain does not redistribute weights; the user accepts this licence when downloading from HF. |
| Gemma Terms | `onnx-community/embeddinggemma-300m-ONNX` | Google's Gemma licence. Permissive for most uses including personal and commercial embedding workloads; redistribution of model weights requires attribution and compliance with Gemma's acceptable use policy. |
