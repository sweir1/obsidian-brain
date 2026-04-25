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

### `models override <id> [flags]` / `models override --list`

User-controlled metadata overrides at `~/.config/obsidian-brain/model-overrides.json`. **Survives `npm update obsidian-brain`** because the file lives outside the package directory. Use it to correct upstream MTEB / HF errors locally without forking the package.

The resolver chain applies overrides as the topmost layer (override → cache → seed → HF → embedder probe → fallback). Any overridden field replaces the resolved value; omitted fields fall through to the next layer. Prefix changes auto-trigger a re-embed via the prefix-strategy hash in `bootstrap.ts`; `maxTokens` changes take effect on the next reindex.

| Flag | Description |
|---|---|
| `--max-tokens <n>` | Override `maxTokens` for this model. Positive integer |
| `--query-prefix <s>` | Override the query-side prefix string |
| `--document-prefix <s>` | Override the document-side prefix string |
| `--remove` | Remove the override for `<id>` (or one of its fields with `--field`) |
| `--field <name>` | With `--remove`: clear only this field (`maxTokens` \| `queryPrefix` \| `documentPrefix`) |
| `--list` | Dump every override on disk and exit (no `<id>` required) |

```bash
# Set an override (corrects MTEB's wrong embed_dim or wrong max-tokens for a model you actually use)
obsidian-brain models override BAAI/bge-small-en-v1.5 --max-tokens 1024 --query-prefix "Custom: "

# List every override
obsidian-brain models override --list

# Remove just one field
obsidian-brain models override BAAI/bge-small-en-v1.5 --remove --field maxTokens

# Remove everything for an id
obsidian-brain models override BAAI/bge-small-en-v1.5 --remove
```

After setting, run `models refresh-cache --model <id>` then restart the server to apply immediately. (Without that, the override takes effect on next boot anyway, but cached rows for that model still hold the old value until the resolver rewrites them.)

The override file is JSON and safe to share via dotfiles — the schema is stable across point releases.

### `models fetch-seed [--url <url>] [--check] [--timeout <ms>]`

Download the latest `data/seed-models.json` from the obsidian-brain `main` branch on GitHub and write it to `~/.config/obsidian-brain/seed-models.json`. The seed-loader checks the user-fetched path **before** the bundled npm-tarball copy, so users get upstream MTEB fixes without waiting for an npm release.

| Flag | Default | Description |
|---|---|---|
| `--url <url>` | GitHub raw URL on `main` | Override the source URL (forks, self-hosted) |
| `--check` | `false` | Download + validate; do not write to disk |
| `--timeout <ms>` | `30000` | HTTP timeout |

```bash
# Pull the latest seed from upstream main
obsidian-brain models fetch-seed

# Validate without writing
obsidian-brain models fetch-seed --check

# Fork / mirror
obsidian-brain models fetch-seed --url https://raw.githubusercontent.com/your-org/obsidian-brain/main/data/seed-models.json
```

The fetched seed must validate against the current schema (`$schemaVersion: 2`). Unsupported schema → refuse to write, print a clear error. Schema bumps require a package update, intentionally — they signal a runtime change that the user-fetched seed alone can't satisfy.

After fetching, run `models refresh-cache` then restart the server to apply to existing cached rows.

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

0. **User overrides** — `~/.config/obsidian-brain/model-overrides.json` (managed via `models override`). Topmost layer; any field set here replaces whatever the lower layers resolved. Survives `npm update`.
1. **Cache** — per-vault SQLite (`embedder_capability` table). Lives forever; only `models refresh-cache` invalidates.
2. **Seed** — `data/seed-models.json`, with two possible sources:
    - `~/.config/obsidian-brain/seed-models.json` if present (fetched via `models fetch-seed` — pulls from the `main` branch on GitHub). Survives `npm update`.
    - Bundled npm-tarball copy as fallback (regenerated at every release via `scripts/build-seed.py` from MTEB's Python registry; ~348 entries).
3. **HF live fetch** — `getEmbeddingMetadata` in `src/embeddings/hf-metadata.ts`. Five HF config endpoints in parallel, plus optional Tier 2 (upstream `base_model`) and Tier 3 (README fingerprinting) for prompt resolution.
4. **Embedder probe** — when HF is unreachable but the embedder is loaded, use `embedder.dimensions()` from the loaded ONNX. Assumes 512 max-tokens, symmetric, no prompts.
5. **Safe defaults** — last resort. 512 max-tokens, no prompts. Boot continues; warning to stderr.

`models check <id>` skips this chain entirely and goes straight to step 3 (always live HF). `models refresh-cache` clears step 1. `models override` writes to step 0. `models fetch-seed` writes to the user copy of step 2. Other commands respect the full chain.

## Files written outside the package

Two files live in `~/.config/obsidian-brain/` (or `$XDG_CONFIG_HOME/obsidian-brain/`, or `$OBSIDIAN_BRAIN_CONFIG_DIR`, or `%APPDATA%/obsidian-brain/` on Windows). Both are intentionally outside the npm package directory so they survive `npm update obsidian-brain`:

| File | Managed by | Resolution priority | Purpose |
|---|---|---|---|
| `model-overrides.json` | `models override` | Highest (Layer 0) | Per-user fixes for upstream errors. Hand-shareable via dotfiles |
| `seed-models.json` | `models fetch-seed` | Above the bundled copy | User-fetched fresher seed without waiting for an npm release |
