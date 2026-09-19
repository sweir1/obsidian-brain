---
title: Configuration
description: Every environment variable obsidian-brain reads, with defaults and the common use-cases for each.
---

# Configuration

obsidian-brain is configured entirely through environment variables. Only `VAULT_PATH` is required; everything else has sensible defaults.

## Environment variables

<!-- GENERATED:env-vars -->
| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | yes | — | Absolute path to your Obsidian vault (or any folder of .md files). |
| `DATA_DIR` | no | — | Where to store the SQLite index + embedding cache. Defaults to $XDG_DATA_HOME/obsidian-brain or ~/.local/share/obsidian-brain. |
| `EMBEDDING_PRESET` | no | english | Preset name: english (default, bge-small-en-v1.5), english-fast, english-quality, multilingual, multilingual-quality, multilingual-ollama, multilingual-openai. Ignored when EMBEDDING_MODEL is set. *Choices: english, english-fast, english-quality, multilingual, multilingual-quality, multilingual-ollama, multilingual-openai* |
| `EMBEDDING_MODEL` | no | — | Power-user override: any transformers.js checkpoint, Ollama model id, or — for EMBEDDING_PROVIDER=openai-compatible — the id of the model the server has loaded. Takes precedence over EMBEDDING_PRESET. Switching auto-reindexes. |
| `EMBEDDING_PROVIDER` | no | transformers | Embedding backend. 'transformers' (local, default), 'ollama' (requires a running Ollama server), or 'openai-compatible' (any server speaking POST /v1/embeddings — llama.cpp's llama-server, LM Studio, vLLM, text-embeddings-inference, or OpenAI itself). Aliases for the last one: openai, llamacpp, llama-cpp, llama.cpp, lmstudio, lm-studio, vllm, tei. *Choices: transformers, ollama, openai-compatible, openai, llamacpp, llama-cpp, llama.cpp, lmstudio, lm-studio, vllm, tei* |
| `OLLAMA_BASE_URL` | no | http://localhost:11434 | Base URL of a local Ollama server. Only used when EMBEDDING_PROVIDER=ollama. |
| `OLLAMA_EMBEDDING_DIM` | no | — | Override the embedding dimensionality when EMBEDDING_PROVIDER=ollama. If unset, the server probes the model on startup. |
| `OLLAMA_NUM_CTX` | no | — | Override Ollama's num_ctx for embed requests. Leave UNSET to let obsidian-brain auto-detect via `/api/show`'s `context_length` (e.g. nomic-embed-text=2048, bge-m3=8192, qwen3-embedding:0.6b=32 768). Setting this manually imposes a hard cap and may silently truncate longer inputs — see https://github.com/ollama/ollama/issues/14259. Ollama's own default is 2048 which truncates for any model trained on a larger context. See also https://github.com/ollama/ollama/issues/7008. Fallback when both env is unset AND /api/show is unreachable: 8192. |
| `OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL` | no | — | Auto-pull the configured Ollama model when /api/show returns 404 (model not present). Default ON — choosing an Ollama-backed preset is implicit consent to download its model. Streams /api/pull progress to stderr. Set to '0' to disable auto-pull entirely (master kill-switch) and fall back to the actionable error path (`HTTP 404 — try: ollama pull <model>`). *Choices: , 0, 1* |
| `OBSIDIAN_BRAIN_OLLAMA_BYOM_AUTO_PULL` | no | — | Opt-in to auto-pull for BYOM (custom EMBEDDING_MODEL) Ollama models OUTSIDE Ollama's official `library/` namespace. Default OFF — third-party models (e.g. `user/custom-fork`, `myregistry.com/team/model`) require this env var to be set to `1` before they will auto-pull, to prevent silent downloads of arbitrary user-named artifacts. Preset-known models (via EMBEDDING_PRESET) and bare model ids in the official library (e.g. `qwen3-embedding:0.6b`, `library/llama3:8b`) continue to auto-pull by default per the existing OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL behavior. *Choices: , 0, 1* |
| `EMBEDDING_BASE_URL` | no | http://localhost:8080 | Base URL of an OpenAI-compatible embedding server. Only used when EMBEDDING_PROVIDER=openai-compatible (or one of its aliases). A trailing '/v1' is optional — it is stripped so both spellings work. Example for llama.cpp: llama-server -m model.gguf --embedding --pooling last --port 8080. |
| `EMBEDDING_DIM` | no | — | Override the embedding dimensionality when EMBEDDING_PROVIDER=openai-compatible. If unset, the server learns it by spending one throwaway embed at startup — the OpenAI protocol has no metadata endpoint to ask. Well-known dims: Qwen3-Embedding-0.6B = 1024, Qwen3-Embedding-4B = 2560, Qwen3-Embedding-8B = 4096, bge-m3 = 1024. |
| `EMBEDDING_API_KEY` | no | — | Bearer token sent to an OpenAI-compatible embedding server. Only used when EMBEDDING_PROVIDER=openai-compatible. Leave unset for a local llama.cpp / LM Studio server, which needs no auth; required when pointing at a hosted endpoint. |
| `OBSIDIAN_BRAIN_NO_WATCH` | no | — | Set to '1' to disable the live chokidar file watcher. Useful on SMB/NFS vaults where FSEvents/inotify don't fire reliably — fall back to running `obsidian-brain index` on a schedule (launchd/systemd). |
| `OBSIDIAN_BRAIN_NO_CATCHUP` | no | — | Set to '1' to skip the startup catchup reindex pass that picks up edits made while the server was down. The live file watcher still starts (via OBSIDIAN_BRAIN_NO_WATCH=1 to disable that separately), and first-time indexing on an empty DB is unaffected — this knob only governs the post-restart `enqueueBackgroundReindex` walk. |
| `OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS` | no | 3000 | Per-file reindex debounce for the live watcher, in milliseconds. |
| `OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS` | no | 60000 | Graph-wide community-detection (Louvain) debounce for the live watcher, in milliseconds. Louvain is the only expensive op — batching it prevents per-edit CPU spikes. |
| `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS` | no | 30000 | Per-tool-call timeout in milliseconds. Tools exceeding this return an MCP error instead of hanging. |
| `OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS` | no | — | Override the adaptive chunk-size budget (in tokens). When set, this beats the capacity probed from the model's tokenizer or Ollama /api/show. Use for debugging or for models with stale tokenizer configs. |
| `OBSIDIAN_BRAIN_CONFIG_DIR` | no | — | Override the per-user config directory where obsidian-brain stores model overrides (`model-overrides.json`) and the user-fetched seed (`seed-models.json`). Default is `$XDG_CONFIG_HOME/obsidian-brain` on macOS/Linux (or `~/.config/obsidian-brain`) and `%APPDATA%/obsidian-brain` on Windows. Both files survive `npm update obsidian-brain` because they live outside the package. |
| `OBSIDIAN_BRAIN_DEBUG` | no |  | Set to "1" to print a verbose synchronous startup trace to stderr — every preflight, createContext, server.connect, and shutdown step is logged with a monotonic timestamp. The LAST line before any silent failure tells you exactly which step the server reached. No-op when unset (no overhead). Use to diagnose silent-crash failure modes. *Choices: , 1* |
| `OBSIDIAN_BRAIN_LOG_FORMAT` | no |  | Set to 'ndjson' for one-JSON-object-per-line stderr output (timestamp + level + message + structured fields). Default is human-readable plain text (`obsidian-brain: <message>`). Useful for piping logs into aggregators (Datadog, Loki, Vector, journald) that index structured fields. *Choices: , ndjson* |
<!-- /GENERATED:env-vars -->

## Notes on specific variables

### `EMBEDDING_PRESET` / `EMBEDDING_MODEL` / `EMBEDDING_PROVIDER`

These three variables control the embedding pipeline. The simplest path is `EMBEDDING_PRESET` — pick one of the named presets and the server resolves the right model, dimensionality, and task prefix automatically.

`EMBEDDING_MODEL` is a power-user escape hatch: set it to any [transformers.js](https://huggingface.co/docs/transformers.js) checkpoint (when `EMBEDDING_PROVIDER=transformers`) or any Ollama model name (when `EMBEDDING_PROVIDER=ollama`). When set, `EMBEDDING_PRESET` is ignored.

**Auto-reindex on model change:** switching models is safe — the server stores the active model identifier and dimension in the DB and rebuilds per-chunk vectors on next boot. No `--drop` flag required.

See [Models](models.md) for the preset table, performance benchmarks, and the Ollama integration guide.

## Legacy aliases

`KG_VAULT_PATH` is accepted as a legacy alias for `VAULT_PATH`. New configs should use `VAULT_PATH`.
