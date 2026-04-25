# CLI reference

The `obsidian-brain` binary is the same Node entry-point that MCP clients spawn — when you run it from a shell, it exposes a few subcommands for inspecting and managing the local install. None of them require an MCP client to be running.

```text
obsidian-brain [options] [command]
```

| Top-level option | Description |
|---|---|
| `-v, --version` | Print the installed version (read from `package.json` at runtime, never drifts) |
| `-h, --help` | Display help for command |

## Commands

### `obsidian-brain server`

Start the stdio MCP server. This is what Claude Desktop / Claude Code / Jan / etc. spawn behind the scenes — you rarely run it by hand. No flags; configuration is via env vars (see [Configuration](configuration.md)).

```bash
obsidian-brain server
```

### `obsidian-brain index [options]`

Scan the vault and update the knowledge-graph index incrementally. Reads `VAULT_PATH` from env. Honors the same model / preset config as `server`.

| Flag | Description |
|---|---|
| `-r, --resolution <n>` | Louvain resolution. Passing this forces a community-cache refresh even if no files changed |
| `--drop` | Drop all embeddings + sync state before indexing. Mostly an escape hatch — since v1.4.0 the bootstrap auto-detects `EMBEDDING_MODEL` / `EMBEDDING_PROVIDER` changes and wipes embedding state on its own |

```bash
obsidian-brain index
```

### `obsidian-brain watch [options]`

Long-running process: keep the index live by reindexing on vault changes. Useful when running the watcher independently from an MCP client (e.g., via launchd / systemd — see [Scheduled indexing (macOS)](launchd.md) / [(Linux)](systemd.md)).

| Flag | Default | Description |
|---|---|---|
| `--debounce <ms>` | `3000` | Per-file reindex debounce |
| `--community-debounce <ms>` | `60000` | Graph-wide community detection debounce |

### `obsidian-brain search [options] <query>`

Run a single search against the indexed vault and print results to stdout as JSON. Supports the same three modes the MCP `search_notes` tool exposes.

| Flag | Default | Description |
|---|---|---|
| `-l, --limit <n>` | `10` | Maximum results |
| `-m, --mode <mode>` | `hybrid` | `hybrid` (RRF-fused, the production default) \| `semantic` \| `fulltext` |

```bash
obsidian-brain search "semantic search architecture" --mode hybrid --limit 5
```

## `obsidian-brain models` — model inspection + management

A subcommand group covering everything related to the embedding model — listing presets, inspecting metadata, prefetching weights, managing the metadata cache.

### `models list [--all] [--filter <substr>]`

By default, prints the 6 hardcoded presets. Pass `--all` to surface every entry in the bundled MTEB-derived seed (~348 dense, text-only, open-weights embedding models catalogued by MTEB as of mteb 2.12.30). `--filter` narrows by case-insensitive substring on model id.

```bash
# Default — the 6 curated presets
obsidian-brain models list

# Every model in the bundled seed (348 entries)
obsidian-brain models list --all

# Find every E5 variant
obsidian-brain models list --all --filter e5

# Find every MongoDB model
obsidian-brain models list --all --filter mongodb
```

Output JSON shape (per entry):

```json
{
  "preset": "english-fast",
  "model": "MongoDB/mdbr-leaf-ir",
  "provider": "transformers",
  "maxTokens": 512,
  "symmetric": false
}
```

Models in the seed but not aliased to a preset have `"preset": null`.

### `models recommend`

First-boot heuristic. Reads `VAULT_PATH`, walks every `.md` file, samples the first 2 KB of each, counts non-Latin characters (CJK, Cyrillic, Arabic, Devanagari, Hebrew, Thai). If more than 5% of sampled characters are non-Latin → recommends `multilingual`. Otherwise → `english`. Picks from the 6 presets only. Skipped entirely if `EMBEDDING_MODEL` / `EMBEDDING_PRESET` is already set, or if the DB has a stored model from a prior boot.

```bash
VAULT_PATH=/path/to/vault obsidian-brain models recommend
```

### `models prefetch [preset]`

Pre-download a preset's model into the HuggingFace cache so the first `index` / `server` run doesn't pay the download cost mid-flight. Defaults to the `english` preset.

```bash
obsidian-brain models prefetch english-fast
```

Currently only takes preset names. For arbitrary HF ids, use `models check <id> --load`.

### `models check <id> [--timeout <ms>] [--load]`

Fetch metadata for any HuggingFace model id from the live HF API — does NOT consult the bundled seed. Default path is metadata-only (~1s round-trip): returns dim, max-tokens, query / document prefixes, prefix source, model-type, base-model, ONNX size, etc. Add `--load` to also download + load via transformers.js (~30s) for end-to-end validation.

| Flag | Default | Description |
|---|---|---|
| `--timeout <ms>` | `10000` | HTTP timeout for HF API calls |
| `--load` | `false` | Also download + load the model (slow) |

```bash
obsidian-brain models check intfloat/multilingual-e5-large
obsidian-brain models check intfloat/multilingual-e5-large --load
```

### `models refresh-cache [--model <id>]`

Invalidate the v1.7.5 metadata cache so the next server boot re-resolves from the seed → HF chain. Cheap for seeded models (~0 HF calls — the 348-entry seed repopulates the cache instantly); 1 HF call per non-seeded BYOM id.

The prefix-strategy hash auto-detects any prefix change and triggers a re-embed in bootstrap, so it's safe to run any time you suspect cached metadata is stale. Restart the server after running this.

| Flag | Description |
|---|---|
| `--model <id>` | Only invalidate that one row (default: every entry) |

```bash
# Invalidate every cached entry
obsidian-brain models refresh-cache

# Invalidate just one model
obsidian-brain models refresh-cache --model MongoDB/mdbr-leaf-ir
```

**Caveat** — running it offline on a non-seeded BYOM id caches fallback safe defaults. Fix by running again online.

## How the model metadata is resolved

Every embedding-model query flows through this chain (Layer 3 in the architecture):

1. **Cache** — per-vault SQLite (`embedder_capability` table). Lives forever; only `models refresh-cache` invalidates.
2. **Seed** — the bundled `data/seed-models.json` (348 entries from MTEB's Python registry, regenerated at every release via `scripts/build-seed.py`).
3. **HF live fetch** — `getEmbeddingMetadata` in `src/embeddings/hf-metadata.ts`. Five HF config endpoints in parallel, plus optional Tier 2 (upstream `base_model`) and Tier 3 (README fingerprinting) for prompt resolution.
4. **Embedder probe** — when HF is unreachable but the embedder is loaded, use `embedder.dimensions()` from the loaded ONNX. Assumes 512 max-tokens, symmetric, no prompts.
5. **Safe defaults** — last resort. 512 max-tokens, no prompts. Boot continues; warning to stderr.

`models check <id>` skips this chain entirely and goes straight to step 3 (always live HF). `models refresh-cache` clears step 1. Other commands respect the full chain.
