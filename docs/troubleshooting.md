---
title: Troubleshooting
description: Known issues, common gotchas, and the fix for each. Covers install, startup, indexing, watcher, and tool-call failure modes.
---

# Troubleshooting

This guide covers errors and edge cases beyond the short Troubleshooting section in the README. Entries are grouped by symptom. If you only have a moment, scan the headers below and jump to the one that matches what you are seeing.

For architecture context (how the indexer, SQLite cache, and MCP server fit together) see [architecture.md](./architecture.md). For client-specific setup see [jan.md](./jan.md), [launchd.md](./launchd.md), and [systemd.md](./systemd.md).

## Contents

- [Connector has no tools available in Claude Desktop](#connector-has-no-tools-available-in-claude-desktop)
- [ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch](#err_dlopen_failed-node_module_version-mismatch)
- [Vault path not configured](#vault-path-not-configured)
- [First run very slow or appears to hang](#first-run-very-slow-or-appears-to-hang)
- [Index stale after a manual edit outside Claude](#index-stale-after-a-manual-edit-outside-claude)
- [tools/call returns "No node found matching X"](#toolscall-returns-no-node-found-matching-x)
- [tools/call returns "Ambiguous name X. Candidates: ..."](#toolscall-returns-ambiguous-name-x-candidates)
- [Transport closed in Jan only (Claude Desktop works fine)](#transport-closed-in-jan-only-claude-desktop-works-fine)
- [launchd job not re-indexing](#launchd-job-not-re-indexing)
- [systemd timer not firing](#systemd-timer-not-firing)
- [SQLite index corrupted or weird schema errors](#sqlite-index-corrupted-or-weird-schema-errors)
- [Embeddings look wrong or search returns irrelevant results](#embeddings-look-wrong-or-search-returns-irrelevant-results)
- [index_status reports a large notesMissingEmbeddings count](#index_status-reports-a-large-notesmissingembeddings-count)
- [After upgrading, semantic search returns {status: "preparing"} for a few minutes](#after-upgrading-semantic-search-returns-status-preparing-for-a-few-minutes)
- [Cached model metadata is stale](#cached-model-metadata-is-stale)
- [tools/list returns -32603 Cannot read properties of undefined (reading '_zod')](#toolslist-returns-32603-cannot-read-properties-of-undefined-reading-_zod)
- [Race condition: edit appears in Claude but not in search for 30 min](#race-condition-edit-appears-in-claude-but-not-in-search-for-30-min)
- [Watcher not firing](#watcher-not-firing)
- [Embedding dimension mismatch error on startup](#embedding-dimension-mismatch-error-on-startup)
- [Collecting MCP server logs](#collecting-mcp-server-logs)
- [Tool calls hang for 4 minutes then time out client-side](#tool-calls-hang-for-4-minutes-then-time-out-client-side)
- [Running multiple MCP clients against the same vault](#running-multiple-mcp-clients-against-the-same-vault)
- [Ghost entries in detect_themes after deleting a note](#ghost-entries-in-detect_themes-after-deleting-a-note)
- [dataview_query returns "Dataview plugin not installed"](#dataview_query-returns-dataview-plugin-not-installed)
- [dataview_query requires companion plugin v0.2.0+](#dataview_query-requires-companion-plugin-v020)
- [dataview_query timed out but the query still runs in Obsidian](#dataview_query-timed-out-but-the-query-still-runs-in-obsidian)
- [`apply_edit_preview` fails with "file has changed since preview"](#apply_edit_preview-fails-with-file-has-changed-since-preview)
- [`edit_note({ mode: "replace_window" })` returns `NoMatch`](#edit_note-mode-replace_window-returns-nomatch)
- [Still stuck?](#still-stuck)

---

## Connector has no tools available in Claude Desktop

**Summary.** The connector is listed and enabled, but the tools palette is empty.

**Cause.** The server process started (so Claude Desktop shows it as connected) but its first `tools/list` response threw. The most common reason is a stale `dist/` directory compiled against a different version of Zod or of the internal schema module than what is now on disk.

**Fix.**

```bash
npm run build
```

Then fully quit Claude Desktop with Cmd-Q (closing the window is not enough; the background process keeps running) and relaunch. If tools still do not appear, read the real error from the Claude Desktop MCP log:

```bash
tail -n 200 ~/Library/Logs/Claude/mcp-server-obsidian-brain.log
```

The stack trace at the bottom of that file is almost always the actual cause.

---

## ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch

**Summary.** Startup fails with a line like `ERR_DLOPEN_FAILED: NODE_MODULE_VERSION X ... requires Y`.

**Cause.** A native module (typically `better-sqlite3`) was compiled against one Node major version during `npm install`, but at runtime a different Node is being used. This very commonly happens when you installed with your shell's `node` (for example from Homebrew or nvm) but the client launches the server with a different `node` from its own bundled runtime or from `/usr/local/bin`.

**npx cache poisoning.** A second common variant: if you ran `npx obsidian-brain@latest server` under Node N, npx cached the compiled `better-sqlite3.node` in `~/.npm/_npx/`. If you later upgrade or downgrade Node (including removing an `fnm` / `nvm` version you had active at the time), the cached binary's ABI no longer matches the runtime.

**Auto-heal (v1.6.11+).** On the first occurrence the server detects the mismatch, spawns a detached `npm rebuild better-sqlite3` in the background, and prints a message telling you to restart your MCP client in about a minute. If you see a line like "Auto-heal: a background rebuild of better-sqlite3 was started (PID …). … restart your MCP client in about 1 minute", just wait and restart — no manual action needed. A marker file at `~/.cache/obsidian-brain/abi-heal-attempted-<ABI>` prevents infinite retry loops: if the rebuild itself fails (typically because the system has no C++ toolchain and no prebuilt is available for your ABI), the second restart falls through to the manual-fix message below.

**Manual fix (v1.6.10 and earlier, or if auto-heal fails):**

```bash
rm -rf ~/.npm/_npx
```

Then restart your MCP client. The next `npx` invocation does a fresh install, which triggers our `postinstall` hook to rebuild `better-sqlite3` against your current Node.

**Fix.** Rebuild the native module under the same Node the client will use:

```bash
# if you installed via npm:
PATH=/opt/homebrew/bin:$PATH npm rebuild -g better-sqlite3

# if you're running from a local source clone:
cd /absolute/path/to/obsidian-brain && PATH=/opt/homebrew/bin:$PATH npm rebuild better-sqlite3
```

Adjust `PATH` so the `node` on it matches the one your client actually launches. If the rebuild itself fails with a missing-compiler error — typical when the initial `npm install` found no prebuilt binary for your Node version and the `node-gyp` fallback didn't have a C++ toolchain to use — install one:

- **macOS**: `xcode-select --install`
- **Debian/Ubuntu**: `sudo apt install build-essential python3`
- **Fedora/RHEL**: `sudo dnf install gcc-c++ make python3`

Then re-run the rebuild command above. To avoid this happening again, prefer the npm-installed path in your client config so the binary is always resolved via Node's own tooling:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/vault"
      }
    }
  }
}
```

---

## Vault path not configured

**Summary.** The server aborts on startup with `Vault path not configured`.

**Cause.** The `VAULT_PATH` environment variable is not set in the server's process environment.

**Fix.** Provide it via one of:

- Export in the shell that launches the server: `export VAULT_PATH=/path/to/vault`.
- Add `VAULT_PATH=/path/to/vault` to a `.env` file in the project root.
- Set it in the `env` block of your MCP client config (see the JSON snippet above).

`KG_VAULT_PATH` is also accepted as a legacy alias and takes precedence if both are set.

---

## First run very slow or appears to hang

**Summary.** The first invocation of any tool takes a minute or more before returning, or the CLI appears frozen.

**Cause.** On first use, the default embedding model (`bge-small-en-v1.5` at ~34 MB; other presets range from 17 MB `fastest` to 118 MB `multilingual`) is downloaded into `DATA_DIR/models/`. No progress is printed to stdout because stdout is the MCP transport.

**Fix.** Wait. Subsequent runs reuse the cached model and start in well under a second. If the download actually failed (network dropped, disk full, etc.) delete the partial download and retry:

```bash
rm -rf "$DATA_DIR/models"
```

The next run will re-download cleanly.

---

## Index stale after a manual edit outside Claude

**Summary.** You edited notes directly in Obsidian (or on disk) and `search` does not reflect the change.

**Cause.** Since v1.1 the `server` watcher normally picks this up within a few seconds. If search is still stale, one of: the watcher is disabled (`OBSIDIAN_BRAIN_NO_WATCH=1`), the vault lives somewhere FSEvents/inotify can't observe (SMB, NFS, some iCloud setups), or you're running on the scheduled-index fallback which only ticks every 30 minutes. See also [Watcher not firing](#watcher-not-firing).

**Fix.** Either call the `reindex` tool from chat, or run the CLI manually:

```bash
# npm-installed:
VAULT_PATH=/path/to/vault obsidian-brain index

# local source clone:
cd /absolute/path/to/obsidian-brain && VAULT_PATH=/path/to/vault node dist/cli/index.js index
```

---

## tools/call returns "No node found matching X"

**Summary.** Tools are listed, but calling one with a name argument returns `No node found matching "X"`.

**Cause.** The fuzzy name resolver could not match the string you passed to any known note.

**Fix.** Try the exact filename (case sensitive, including folder prefix if the note lives in a subfolder). If you are not sure of the exact name, call `search` first and pass the result's `id` field to `read_note`. IDs always resolve unambiguously.

---

## tools/call returns "Ambiguous name X. Candidates: ..."

**Summary.** The tool rejects your input and lists two or more candidate notes.

**Cause.** Multiple notes fuzzy-match the name you supplied.

**Fix.** Pass one of the `id` values from the candidate list instead of the short name. For example, pass `Concepts/Widget Theory.md` rather than `Widget` if both `Concepts/Widget Theory.md` and `Projects/Widget Launch.md` were listed as candidates.

---

## Transport closed in Jan only (Claude Desktop works fine)

**Summary.** Jan reports `Transport closed` within seconds of launching the connector; the same server works fine in Claude Desktop.

**Cause.** Jan 0.7.x ships an rmcp client with an open bug ([rust-sdk#468](https://github.com/modelcontextprotocol/rust-sdk/issues/468)) parsing SSE frames from Streamable HTTP MCP servers. This only affects HTTP transports. obsidian-brain is stdio-only at source, so if you are hitting this you have configured Jan to talk to it over HTTP (likely via an HTTP proxy or wrapper).

**Fix.** Remove the HTTP entry and add a stdio entry per [jan.md](./jan.md). The rmcp bug does not apply to stdio, and obsidian-brain is a stdio server; you only want the HTTP path if you have wrapped it in a proxy on purpose.

---

## launchd job not re-indexing

**Summary.** You set up a launchd agent for periodic reindexing on macOS, but the index never refreshes.

**Cause.** Usually the `PATH` inside the plist does not include the directory containing your `node` binary, or `VAULT_PATH` in the plist's `EnvironmentVariables` block points somewhere wrong.

**Fix.** Check the stderr log and reload the job:

```bash
tail -f /tmp/obsidian-brain-index.err
launchctl unload ~/Library/LaunchAgents/com.you.obsidian-brain.plist
launchctl load ~/Library/LaunchAgents/com.you.obsidian-brain.plist
launchctl list | grep obsidian-brain
```

If `launchctl list` shows a non-zero exit status in the second column, the most recent run failed; the stderr log will tell you why. See [launchd.md](./launchd.md) for the full plist template, including the correct `PATH` and `EnvironmentVariables` entries.

---

## systemd timer not firing

**Summary.** You set up a user-level systemd timer on Linux and no reindex ever happens.

**Cause.** Usually the service unit's `ExecStart` points at the wrong `node` binary, or the timer was written but never enabled.

**Fix.**

```bash
systemctl --user status obsidian-brain.service
journalctl --user -u obsidian-brain.service -n 50
systemctl --user list-timers | grep obsidian-brain
```

If `status=203/EXEC` appears, the kernel could not execute the `ExecStart` path — fix the `node` path in the unit file. If the timer is not in `list-timers`, you likely forgot to enable it:

```ini
# Enable and start the timer
systemctl --user enable --now obsidian-brain.timer
```

See [systemd.md](./systemd.md) for the full unit file templates.

---

## SQLite index corrupted or weird schema errors

**Summary.** Startup or queries fail with messages like `database disk image is malformed`, `no such column`, or other schema-level SQLite errors.

**Cause.** Rare but possible after a crash or power loss mid-write. Can also occur if you rolled back to an older server build whose migrations do not match the on-disk schema.

**Fix.** Delete the data directory and reindex:

```bash
rm -rf "$DATA_DIR"
```

Default locations: `$HOME/.local/share/obsidian-brain` on Linux, `$HOME/Library/Application Support/obsidian-brain` on macOS, or whatever `DATA_DIR` points at if you set it explicitly. You will lose the SQLite cache but not any vault content; the next run will rebuild the cache from your notes.

---

## Embeddings look wrong or search returns irrelevant results

**Summary.** `search` returns notes that seem unrelated to your query, or misses obviously-matching ones.

**Cause.** Two common reasons:

1. The embedding model's notion of semantic similarity does not match what you actually want (this happens often with short or jargon-heavy queries).
2. Your vault is mostly empty or stub notes, so there is not enough signal for embedding-based retrieval to work well.

**Fix.** Since v1.4.0, the default `search` mode is already `hybrid` — Reciprocal-Rank-Fused semantic + full-text — so both signals combine out of the box. If the hybrid result still misses literal-token matches you know are in your vault, force FTS:

```json
{ "mode": "fulltext" }
```

passed via `search`. For pure concept queries, force semantic:

```json
{ "mode": "semantic" }
```

If you want better semantic retrieval overall, switch to a larger model — since v1.4.0 the server stores the active embedding model/dim/provider in `index_metadata` and **auto-reindexes from scratch the next time it boots under a new identifier**. No `--drop` needed:

```bash
EMBEDDING_MODEL=Xenova/bge-base-en-v1.5 obsidian-brain server
# or for the Ollama path (v1.5.0+):
EMBEDDING_PROVIDER=ollama EMBEDDING_MODEL=nomic-embed-text obsidian-brain server
```

On the next startup the server logs a single reason line ("Embedding model changed: X(d) → Y(d'). Auto-reindexing.") and rebuilds per-chunk embeddings. See [Architecture → Why local embeddings](./architecture.md#why-local-embeddings) for the bootstrap flow.

---

## index_status reports a large `notesMissingEmbeddings` count

**Summary.** `index_status` shows e.g. "2,639 / 3,867 notes indexed; 1,228 missing" and the count doesn't change across reindexes.

**Cause.** Pre-v1.7.3, notes whose body produced zero chunks (empty files, frontmatter-only metadata notes, embeds-only collector notes, daily notes with just `# 2026-04-25` and no body, anything shorter than `minChunkChars` after frontmatter strip) were silently dropped by the chunker. The end-of-reindex self-heal would wipe their `sync.mtime` and try again on the next pass — same empty-body, same zero chunks, infinite no-op loop. The missing count stayed pinned regardless of what embedder you used because the cause was structural, not model-specific.

**Fix.** Upgrade to v1.7.3 or newer. The indexer now synthesises a fallback chunk from `title + tags + scalar frontmatter values + first 5 wikilink/embed targets` so daily notes etc. stay searchable by name. Notes with literally nothing to embed (no title, no frontmatter, no body) are recorded once in `failed_chunks` with reason `no-embeddable-content` and surfaced as a distinct bucket in `index_status`. After the next reindex, `notesNoEmbeddableContent` will show the count of structurally-unembeddable notes and `notesMissingEmbeddings` will reflect only genuine failures (typically <5% of any normal vault).

---

## After upgrading, semantic search returns `{status: "preparing"}` for a few minutes

**Summary.** After an `npx obsidian-brain@latest` upgrade, the next boot does a one-time auto-reindex.

**Cause.** Several v1.7.x releases shipped one-time auto-reindex triggers:

- **v1.7.4** swapped the `english-fast` preset model from `Xenova/paraphrase-MiniLM-L3-v2` (17 MB, 384d, symmetric) to `MongoDB/mdbr-leaf-ir` (22 MB, 1024d, asymmetric mxbai-style query prefix). Anyone on `EMBEDDING_PRESET=english-fast` (or the deprecated `fastest` alias) re-embeds once.
- **v1.7.5** bumped schema v6 → v7 to add seven metadata-cache columns to `embedder_capability`. The migration is additive (nullable columns, ALTER TABLE), so existing data is preserved — but the schema-version bump itself triggers a reindex reason on the boot that performs the migration.

**Fix.** No action required. Semantic search returns `{status: "preparing"}` during the rebuild; fulltext search and every non-semantic tool work throughout. Typical 3000-note vault re-embeds in 5–15 minutes. If you want to pin the old `english-fast` model explicitly, set `EMBEDDING_MODEL=Xenova/paraphrase-MiniLM-L3-v2` to override the preset.

---

## Cached model metadata is stale

**Summary.** A model author fixed an upstream config (e.g. corrected a `tokenizer_config.json` `model_max_length` that used to lie) and you want the new value picked up immediately rather than waiting for the v1.7.5 90-day TTL to lapse.

**Fix.** Set `OBSIDIAN_BRAIN_REFETCH_METADATA=1` in your client config and restart:

```json
{
  "env": {
    "VAULT_PATH": "/path/to/vault",
    "OBSIDIAN_BRAIN_REFETCH_METADATA": "1"
  }
}
```

The next boot synchronously refetches the model's metadata from HuggingFace, writes it to the `embedder_capability` cache, and (if dim or prefix changed) triggers a one-time auto-reindex. Once the refetch is done, you can remove the env var — the regular 90-day TTL takes over.

---

## tools/list returns -32603 Cannot read properties of undefined (reading '_zod')

**Summary.** The client gets JSON-RPC error `-32603` with the message `Cannot read properties of undefined (reading '_zod')` when listing tools.

**Cause.** A tool handler somewhere uses the deprecated single-argument form `z.record(x)`. Newer Zod versions require the two-argument form `z.record(z.string(), x)`.

**Fix.** In the handler file, change:

```ts
z.record(someSchema)
```

to:

```ts
z.record(z.string(), someSchema)
```

Rebuild and restart the client. This is rare in our code (we have fixed it once already), but worth knowing if you are writing your own tools against the same SDK.

---

## Race condition: edit appears in Claude but not in search for 30 min

**Summary.** You wrote a note via an MCP tool. It shows up on disk and in Obsidian immediately, but `search` does not find it until much later.

**Cause.** The write tool refreshes the affected file in the index immediately after the write succeeds, and the live watcher catches it on disk as a second-chance. If both failed (transient SQLite lock, filesystem error, or watcher disabled on a vault FSEvents can't observe), the file won't show up in search until the next scheduled pass from launchd or systemd — which only runs if you've set up a timer-based fallback, otherwise never.

**Fix.** Check the MCP server log for a re-index error near the time of the write:

```bash
tail -n 200 ~/Library/Logs/Claude/mcp-server-obsidian-brain.log
```

You can force a refresh immediately by calling the `reindex` tool, or by running the CLI command shown in the "Index stale" section above.

---

## Watcher not firing

**Summary.** `obsidian-brain server` is running but edits made in Obsidian don't show up in `search` until you call `reindex` manually.

**Cause.** One of:

1. Vault on a network drive. macOS FSEvents and Linux inotify don't reliably observe changes on SMB/NFS shares (and iCloud Drive is its own mess). Workaround: set `OBSIDIAN_BRAIN_NO_WATCH=1` and use a scheduled `obsidian-brain index` via launchd / systemd instead.
2. `OBSIDIAN_BRAIN_NO_WATCH=1` is set somewhere you forgot about — inherited from a shell, a launchd `EnvironmentVariables` block, or a systemd `Environment=` line.
3. Obsidian's own save debounce is longer than our reindex debounce. If the file hasn't actually landed on disk yet, chokidar can't see it. Check Obsidian → Settings → Files and links.
4. The file isn't a `.md`. The watcher ignores everything else by design.

**Fix.** First confirm the watcher started — on stderr you should see a line like:

```
obsidian-brain: watching /absolute/path/to/vault for changes
```

If that line is missing, check `OBSIDIAN_BRAIN_NO_WATCH`. If it's present, the issue is one of the platform causes above.

---

## Embedding dimension mismatch error on startup

**Summary.** Server aborts with an error about embedding dimensions not matching the stored index.

**Cause.** You're running a **pre-v1.4.0 server** and changed `EMBEDDING_MODEL` to a model whose output dimensionality differs from the stored index (e.g. 384 → 768). The old server couldn't auto-migrate across dim changes.

**Fix.** Upgrade to v1.4.0 or later — `src/pipeline/bootstrap.ts` records the active model/dim/provider in the `index_metadata` table and, when any of those differs on startup, automatically drops the vec tables + sync mtimes and rebuilds per-chunk embeddings against the new model on next boot. No `--drop` flag required; just set the new env var and restart:

```bash
EMBEDDING_MODEL=Xenova/bge-base-en-v1.5 obsidian-brain server
```

If you are stuck on an older release and cannot upgrade, wipe `$DATA_DIR` and let the fresh index build under the new model (vault content is untouched):

```bash
rm -rf "$DATA_DIR"
```

---

## Collecting MCP server logs

**Summary.** You're debugging a hang, a timeout, or weird tool output and want to see what the server actually did.

**Where the logs live.**

- **macOS (Claude Desktop)**: `~/Library/Logs/Claude/mcp-server-obsidian-brain.log`
- **Windows (Claude Desktop)**: `%APPDATA%\Claude\logs\mcp-server-obsidian-brain.log`
- **Linux (Claude Desktop)**: `~/.config/Claude/logs/mcp-server-obsidian-brain.log`
- **Other clients** (Cursor, Jan, VS Code, Cline, Zed, etc.): each writes to its own location — check the client's own logs directory.

**What the log contains.** Every inbound `Message from client` and outbound `Message from server` line is logged with an ISO timestamp. Each tool call has a matching `id` on both sides.

**Quick way to see round-trip times per tool call.** Extract just the `tools/call` requests and their matching responses with the time delta:

```bash
grep -E 'Message from (client|server)' ~/Library/Logs/Claude/mcp-server-obsidian-brain.log \
  | grep -E '"method":"tools/call"|"result":|"error":' \
  | awk -F'[T"]' '{print substr($0,1,23), $0}'
```

If request `id=N` has a `Message from client` and then a `Message from server` with the same `id` milliseconds later, the server responded fast. If there's a big gap between the client message and the server's response, the server was busy. **If there's NO server response at all for an `id`, the server never received it** — that's a client-side transport problem, not ours.

**Note for v1.2.1+**: per-tool-call timeouts default to 30s. If the server hits that internally, it returns a visible error rather than hanging silently. Set `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS=<millis>` to tune.

---

## Tool calls hang for 4 minutes then time out client-side

**Summary.** A tool call appears to hang until your MCP client gives up with a "No result received" message after ~4 minutes. Subsequent calls in the same session also hang. Restarting the client fixes it.

**Cause.** Almost always a client-side stdio transport stall, not a server-side hang. Both Claude Desktop and some other MCP clients have intermittent buffer/write issues where a request you think you sent never actually makes it down the pipe. The server sits there waiting; the client's internal timeout eventually trips.

**How to tell.** Compare the request `id` in the client's log against the server log at the path above. If the request never appears in the server log's `Message from client` lines, the server never saw it — confirms it's a client issue.

**Fix / mitigation.**

- Restart the MCP client (⌘Q in Claude Desktop, then reopen).
- Since v1.2.1, the server itself times out any tool handler that runs longer than `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS` (default 30000) and returns an actionable error. So a future hang that IS server-side will surface much faster.
- If it's reproducible, please attach the server log (macOS path above) to an issue at <https://github.com/sweir1/obsidian-brain/issues>.

---

## Running multiple MCP clients against the same vault

**Summary.** You have `obsidian-brain` configured in two clients (e.g. Claude Desktop AND Cursor) pointing at the same `VAULT_PATH`.

**How it works.** Each MCP client spawns its own `obsidian-brain server` process. Both processes share the vault directory and the default `DATA_DIR`, which means they share the SQLite index file.

**Correctness.** Fine. SQLite is in WAL mode plus (v1.2.1+) a 5-second `busy_timeout`, so concurrent writers serialise cleanly instead of throwing `SQLITE_BUSY`. Reads from one process don't block writes from the other.

**Efficiency caveats.**

- Both processes run a startup catchup reindex on boot → duplicate work on every relaunch. Set `OBSIDIAN_BRAIN_NO_CATCHUP=1` in the less-used client's config to skip it there.
- Both chokidar watchers fire on every file change → duplicate live-reindexing. Set `OBSIDIAN_BRAIN_NO_WATCH=1` in one of the client configs if you want only one watcher live.
- Each process loads its own embedder (~200 MB RAM, shared model file on disk cached under `DATA_DIR/transformers-cache` so only one download).

**If you hit `SQLITE_BUSY` despite the timeout**: one of your processes is holding a very long write transaction. Most likely a stuck catchup indexing a huge backlog. `OBSIDIAN_BRAIN_NO_CATCHUP=1` in all but one client fixes it.

---

## Ghost entries in `detect_themes` after deleting a note

**Summary.** `detect_themes` lists a cluster member that no longer exists on disk — the file was deleted but the id keeps showing up. `reindex` didn't clean it up either.

**Cause.** Pre-v1.2.2 `delete_note` cascaded to nodes, edges, embeddings, and sync state — but NOT to the `communities` table. The deleted note's id stayed in the JSON `node_ids` array of whichever community it belonged to. Since the incremental index run skipped community-refresh when nothing was indexed, the ghost persisted indefinitely.

**Fix.** Upgrade to v1.2.2 or later. The underlying fix ships as part of that release:

- `deleteNode` now prunes the id from every community row via `pruneNodeFromCommunities`.
- `reindex` forces a fresh Louvain pass whenever an explicit `resolution` is passed OR any deletion is detected, so a single reindex will clean up ghosts accumulated on older versions.

To clean up existing ghosts after upgrading, run once:

```bash
VAULT_PATH=/path/to/vault obsidian-brain index --resolution 1.0
```

The `--resolution` argument is the explicit-intent signal that forces the community refresh. Any positive value works — `1.0` is the default Louvain resolution.

**Related v1.2.2 change.** `detect_themes` no longer accepts a `resolution` parameter — it was silently ignored before. To recompute with a different resolution, call `reindex({ resolution: X })` first, then `detect_themes` to read the updated cache.

---

## dataview_query returns "Dataview plugin not installed"

**Summary.** The tool returns an error like *"The Dataview community plugin is not installed or not enabled in this vault. Install it from Settings → Community plugins and retry."*

**Cause.** The companion plugin proxies DQL through Dataview's own `api.query()`. If the Dataview plugin isn't installed (or isn't enabled) in the same vault, the companion responds with HTTP 424 and the server surfaces the remediation text.

**Fix.**

1. Open Obsidian → Settings → Community plugins → Browse → search "Dataview" (by blacksmithgu) → install → enable.
2. Reload Obsidian. The companion checks for Dataview via the plugin global at request time; a fresh install occasionally needs a reload before `app.plugins.plugins.dataview.api` appears.
3. Re-run the tool.

Dataview and obsidian-brain companion are independent plugins — you need both enabled.

---

## dataview_query requires companion plugin v0.2.0+

**Summary.** The tool fails fast with *"dataview_query requires the companion plugin v0.2.0 or later. Your installed plugin version is 0.1.x."*

**Cause.** Since v1.3.0 the server reads a `capabilities: string[]` field from the plugin's discovery file and gates `dataview_query` on the `"dataview"` capability *before* making the HTTP call. v0.1.x plugins don't advertise this capability, so the server refuses rather than opaque-404ing at `/dataview`.

**Fix.** Upgrade the plugin:

- **BRAT** — open the BRAT command palette → `Plugins: Check for updates` → confirm `obsidian-brain-companion` is on v0.2.0.
- **Manual** — download `main.js` + `manifest.json` from the [latest plugin release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest), overwrite the existing files under `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`, then disable + re-enable the plugin under Settings → Community plugins so the HTTP server rebinds with the new route table.

After the plugin restarts, its `discovery.json` will contain `"capabilities": ["status", "active", "dataview"]` and the tool works.

---

## dataview_query timed out but the query still runs in Obsidian

**Summary.** `dataview_query` returns *"Dataview query exceeded timeoutMs=30000. The query is still running inside Obsidian (Dataview has no cancellation API). Add LIMIT to your DQL or raise timeoutMs."*

**Cause.** Dataview's `api.query()` does not accept an AbortSignal or a timeout parameter. The server's `timeoutMs` is a bound on the HTTP wait only — when it fires, the plugin side keeps working on the original query until it completes, at which point its response is simply discarded. For very large vaults or broad queries, this can burn CPU for minutes.

**Fix.**

1. **Add `LIMIT N`** to your DQL — almost any TABLE / LIST query benefits from `LIMIT 100`. DQL evaluates LIMIT server-side inside Dataview, so the work stops early.
2. **Narrow the FROM clause** — prefer `FROM #specific-tag` over bare `FROM ""`, or restrict by folder via `FROM "2024/journal"`.
3. **Raise `timeoutMs`** only if the query is genuinely expensive and you're willing to wait; retrying with a larger budget doesn't speed up the current in-flight query since it's still running.

The companion plugin serialises `/dataview` requests — a second call queues behind the first, so retries don't stack CPU load. Concurrency is one in-flight query at a time per plugin.

---

## `apply_edit_preview` fails with "file has changed since preview"

You called `edit_note({ dryRun: true })`, got a `previewId`, but between then and `apply_edit_preview(previewId)` the target file was modified (either by you, Obsidian's autosave, or another tool call). The preview's cached `originalContent` no longer matches what's on disk, and the tool refuses to apply rather than clobber intervening changes.

**Fix:** regenerate the preview. Re-call `edit_note({ dryRun: true, ...same args... })` — you'll get a fresh `previewId` computed against the current file content. Then `apply_edit_preview(newPreviewId)`.

Preview TTL is 5 minutes. If you wait longer than that between dry-run and apply, you'll see `"Preview <previewId> not found or expired"` instead — same fix.

---

## `edit_note({ mode: "replace_window" })` returns `NoMatch`

Your `search` string didn't match anything in the target file. Three common causes: (a) the file content changed since you read it, (b) the search string has subtle whitespace / punctuation drift, (c) you're editing a note that was re-generated and the anchor text no longer exists.

**Quick fix — retry with `from_buffer`:**

```json
edit_note({ "name": "foo.md", "from_buffer": true })
```

When `replace_window` fails with `NoMatch`, obsidian-brain buffers the proposed `content` + `search` under the file path. A follow-up call with `from_buffer: true` retrieves the buffered content and retries with `fuzzy: true, fuzzyThreshold: 0.5` — tolerant enough to match through whitespace drift and minor wording changes.

**Manual alternative:** re-issue the original call with `fuzzy: true` + a lower `fuzzyThreshold` (e.g. `0.5`) yourself, tightening the `search` string to match what's actually in the file.

Buffer TTL is 30 minutes; per-entry content cap is 512 KB. If your `replace_window` content is larger than that, the buffer refuses to accept it — the tool response will include a `reason` field explaining why.

---

## Claude Desktop / Jan can't find node or npx

**Symptom.** The client's MCP log shows `spawn npx ENOENT` or `spawn node ENOENT`.

**Cause.** GUI apps on macOS inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`) and don't see `/opt/homebrew/bin` where Homebrew installs node.

**Fix.**

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf "$(which node)" /usr/local/bin/node
sudo ln -sf "$(which npx)" /usr/local/bin/npx
```

Then restart the client. **Alternative:** use absolute paths in the client config (`"command": "/opt/homebrew/bin/npx"`). The symlink is preferred because it survives config-shape churn across client updates.

---

## macOS: vault reads fail or the embedding-model download hangs silently

**Symptom.** The server starts but `search` returns zero results, or the first-boot model download never finishes (no progress in the log).

**Cause.** macOS Full Disk Access not granted to the client. obsidian-brain inherits the client's filesystem privileges.

**Fix.** Open **System Settings → Privacy & Security → Full Disk Access**, enable the client (Claude Desktop / Jan / Cursor / etc.), then quit and relaunch the client.

Note: granting *Files & Folders* access for the specific vault folder is not sufficient — transformers.js downloads the model to a cache path that usually falls outside any per-folder grant. Full Disk Access is required.

---

## npx is launching an old version

**Symptom.** Logs show obsidian-brain v1.2.x starting even though npm shows v1.6.x as `latest`.

**Cause.** npx caches resolved versions under `~/.npm/_npx`. If the cached entry for `obsidian-brain` is stale and the config uses `npx obsidian-brain` (no `@latest`), npx reuses the cache.

**Fix.**

```bash
rm -rf ~/.npm/_npx
```

Then restart the client. **Prevention:** always use `obsidian-brain@latest` in your client config — the `@latest` tag forces npx to re-resolve from npm on every launch. All config examples in this repo use `@latest` for this reason.

---

## The embedding-model cache looks corrupt

**Symptom.** `onnxruntime` errors, or `Invalid model file` at boot.

**Cause.** An interrupted model download left a truncated file in the transformers.js cache.

**Fix.** Delete the cache directory and let it re-download:

```bash
# Default transformers.js cache location when DATA_DIR is unset
rm -rf ~/.cache/huggingface
# If you set DATA_DIR, the model lives under $DATA_DIR/models instead
```

Then restart the client. First boot will re-download (~34 MB for the english preset, ~135 MB for multilingual).

---

## Still stuck?

If none of the above matches, the two places to look next are:

- **The Claude Desktop MCP log** at `~/Library/Logs/Claude/mcp-server-obsidian-brain.log` (macOS) or the equivalent on your platform. The stack trace at the bottom almost always contains the real error. For other clients, consult that client's own log location.
- **The GitHub issues tracker** at [https://github.com/sweir1/obsidian-brain/issues](https://github.com/sweir1/obsidian-brain/issues). Search for your error text first; if nothing matches, open a new issue including the log excerpt, your Node version (`node --version`), your OS, and the MCP client and version.
