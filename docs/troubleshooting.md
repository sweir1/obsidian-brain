# Troubleshooting obsidian-brain

This guide covers errors and edge cases beyond the short Troubleshooting section in the README. Entries are grouped by symptom. If you only have a moment, scan the headers below and jump to the one that matches what you are seeing.

For architecture context (how the indexer, SQLite cache, and MCP server fit together) see [architecture.md](./architecture.md). For client-specific setup see [jan.md](./jan.md), [launchd.md](./launchd.md), and [systemd.md](./systemd.md).

## Contents

- [Connector has no tools available in Claude Desktop](#connector-has-no-tools-available-in-claude-desktop)
- [ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch](#err_dlopen_failed-node_module_version-mismatch)
- [Vault path not configured](#vault-path-not-configured)
- [First run very slow or appears to hang](#first-run-very-slow-or-appears-to-hang)
- [Index stale after a manual edit outside Claude](#index-stale-after-a-manual-edit-outside-claude)
- [tools/call returns "No node found matching X"](#toolscall-returns-no-node-found-matching-x)
- [tools/call returns "Ambiguous name X. Candidates: ..."](#toolscall-returns-ambiguous-name-x-candidates-)
- [Transport closed in Jan only (Claude Desktop works fine)](#transport-closed-in-jan-only-claude-desktop-works-fine)
- [launchd job not re-indexing](#launchd-job-not-re-indexing)
- [systemd timer not firing](#systemd-timer-not-firing)
- [SQLite index corrupted or weird schema errors](#sqlite-index-corrupted-or-weird-schema-errors)
- [Embeddings look wrong or search returns irrelevant results](#embeddings-look-wrong-or-search-returns-irrelevant-results)
- [tools/list returns -32603 Cannot read properties of undefined (reading '_zod')](#toolslist-returns--32603-cannot-read-properties-of-undefined-reading-_zod)
- [Race condition: edit appears in Claude but not in search for 30 min](#race-condition-edit-appears-in-claude-but-not-in-search-for-30-min)
- [Watcher not firing](#watcher-not-firing)
- [Embedding dimension mismatch error on startup](#embedding-dimension-mismatch-error-on-startup)
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
      "args": ["-y", "obsidian-brain", "server"],
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

**Cause.** On first use, the embedding model (`all-MiniLM-L6-v2`, roughly 22 MB) is downloaded into `DATA_DIR/models/`. No progress is printed to stdout because stdout is the MCP transport.

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

**Fix.** Try a full-text search instead:

```json
{ "mode": "fulltext" }
```

passed via `search`. If you want better semantic retrieval and can tolerate slower indexing, switch to a larger model:

```bash
VAULT_PATH=/path/to/vault EMBEDDING_MODEL=Xenova/all-mpnet-base-v2 obsidian-brain index --drop
```

`--drop` is required when the new model's output dim differs from the stored index (e.g. all-mpnet-base-v2 is 768-dim vs all-MiniLM's 384). `all-mpnet-base-v2` is noticeably higher quality but also noticeably slower and larger on disk.

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

**Cause.** You changed `EMBEDDING_MODEL` to a model whose output dimensionality is different from the model used when the index was originally built (e.g. moved from `all-MiniLM-L6-v2` at 384 dims to `all-mpnet-base-v2` at 768 dims). The stored vectors and the new model are incompatible.

**Fix.** Rebuild the index from scratch with the new model:

```bash
VAULT_PATH=/path/to/vault EMBEDDING_MODEL=Xenova/all-mpnet-base-v2 obsidian-brain index --drop
```

`--drop` wipes stored embeddings and per-file sync state, then reindexes the vault fresh. The vault content itself is untouched.

---

## Still stuck?

If none of the above matches, the two places to look next are:

- **The Claude Desktop MCP log** at `~/Library/Logs/Claude/mcp-server-obsidian-brain.log` (macOS) or the equivalent on your platform. The stack trace at the bottom almost always contains the real error. For other clients, consult that client's own log location.
- **The GitHub issues tracker** at [https://github.com/sweir1/obsidian-brain/issues](https://github.com/sweir1/obsidian-brain/issues). Search for your error text first; if nothing matches, open a new issue including the log excerpt, your Node version (`node --version`), your OS, and the MCP client and version.
