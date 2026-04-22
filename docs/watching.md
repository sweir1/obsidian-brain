# Live watching

Deep-dive on the watcher that keeps obsidian-brain's index in sync with vault edits. Architectural placement is in [architecture.md](./architecture.md#live-sync).

## Why it's on by default in `server`

Before v1.1, the server read a snapshot of the vault and relied on a separate scheduled `obsidian-brain index` to catch new edits — a 30-minute staleness window, plus the requirement to set up launchd/systemd just to make search usable.

Since v1.1, `obsidian-brain server` starts a chokidar watcher on the vault path. Every editor save in Obsidian triggers an incremental reindex of the changed file, typically within a few seconds. No extra daemon to install, no timer to tune, and the scheduled-index fallback is still there for people who want it (set `OBSIDIAN_BRAIN_NO_WATCH=1`).

## Chokidar under the hood

We use [chokidar](https://github.com/paulmillr/chokidar), which wraps the platform-native change API:

- **macOS**: FSEvents
- **Linux**: inotify
- **Windows**: ReadDirectoryChangesW

No polling. Idle CPU is effectively zero; you pay only when a file changes.

Chokidar emits a few event types — `add`, `change`, `unlink`. We react to all three:

- `add` / `change` → reindex the file (parse frontmatter + inline Dataview `key:: value` fields, re-embed, upsert node + edges).
- `unlink` → delete the node and its edges from the index.

Only `.md` files are watched. Everything else is ignored.

## The two debounces and why they differ

| Debounce | Default | What it covers |
|---|---|---|
| Per-file | 3000 ms | Collapses bursts of saves on a single file into one reindex. |
| Community (graph-wide) | 60000 ms | Delays Louvain community detection until the vault settles. |

Per-file debounce is keyed by path. If you save `Note A.md` three times in a second and then `Note B.md` once, you get exactly two reindex operations 3 s after the last save of each file. That's the Obsidian autosave behaviour covered in the next section.

Community debounce is separate because Louvain runs over the entire graph and dominates cost on large vaults. Running it after every single file change would thrash; running it once per minute keeps `detect_themes` responsive without making per-file reindex slow.

Flow: Obsidian saves file → chokidar `change` event → 3 s per-file debounce → `indexSingleNote` (`src/pipeline/indexer.ts:indexSingleNote`) parses, embeds, upserts → community flag set dirty → 60 s later Louvain re-runs and clears the flag.

## Obsidian's autosave and how we layer on top

Obsidian writes files to disk on a roughly 2-second debounce after you stop typing. During a long editing session this means a single note may be rewritten dozens of times — once for each pause longer than 2 s.

Our 3-second per-file debounce sits just above Obsidian's, which means:

- A single pause-and-resume editing pattern produces one reindex per "real" pause, not one per keystroke.
- A 30-minute continuous editing session on one note produces exactly one reindex, 3 s after the last save.
- The debounce timer resets on every save event, so nothing is ever reindexed mid-edit.

If you actually *want* to see search-worthy updates within 2 s of every save, lower `OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS`. It costs CPU proportional to the number of autosaves you trigger.

## Tuning

All three are environment variables read at server startup:

| Env var | Default | Effect |
|---|---|---|
| `OBSIDIAN_BRAIN_NO_WATCH` | unset | Set to `1` to disable the watcher entirely; falls back to the scheduled-index model. |
| `OBSIDIAN_BRAIN_WATCH_DEBOUNCE_MS` | `3000` | Per-file reindex debounce. Lower for snappier search, higher for less CPU. |
| `OBSIDIAN_BRAIN_COMMUNITY_DEBOUNCE_MS` | `60000` | Graph-wide community detection debounce. Keep this high unless you actively call `detect_themes` frequently. |

No restart hot-reload — changes take effect next time `server` (or `watch`) starts.

## Standalone daemon mode: `obsidian-brain watch`

If you don't run an MCP client continuously — for example you only launch Claude Desktop occasionally, but still want the index fresh so the first `search` is instant — use the `watch` subcommand. It's the same watcher code as `server`, minus the MCP transport.

```bash
VAULT_PATH=/path/to/vault obsidian-brain watch
```

Point launchd (macOS) or systemd (Linux) at it and let it run continuously. Templates in [launchd.md](./launchd.md#recommended-run-the-watcher-instead) and [systemd.md](./systemd.md#recommended-run-the-watcher-instead).

## Troubleshooting pointers

If edits aren't landing in the index, see [troubleshooting.md → Watcher not firing](./troubleshooting.md#watcher-not-firing). Most common causes: vault on a network drive where FSEvents/inotify don't fire, or `OBSIDIAN_BRAIN_NO_WATCH=1` inherited from a shell or plist.

For the rarer case of an `EMBEDDING_MODEL` swap that leaves stale-dim vectors in the index, see [troubleshooting.md → Embedding dimension mismatch](./troubleshooting.md#embedding-dimension-mismatch-error-on-startup). Fix is `obsidian-brain index --drop`.
