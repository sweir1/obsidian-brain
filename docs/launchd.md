---
title: Scheduled indexing (macOS)
description: Run obsidian-brain as a macOS LaunchAgent — either the live watcher or a timer-driven reindex.
---

# Scheduled indexing (macOS)

!!! note "Most users don't need this"
    `obsidian-brain server` auto-watches the vault when running from any MCP client (Claude Desktop, Cursor, Claude Code, Jan, etc.) — the index stays live as you edit, no scheduled job required. Use scheduled indexing only when you can't keep `server` running continuously: headless setups, cron-only environments, or vaults on filesystems where chokidar's native watcher misses events (SMB, some NFS, sometimes iCloud).

Two approaches for keeping the index fresh on macOS outside of an active MCP client session: a persistent `watch` daemon that mirrors Obsidian edits in real time, or a timer-driven `index` job that runs every 30 minutes. Both use launchd LaunchAgents — no root required.

## Recommended: run the watcher instead

The `server` subcommand watches the vault by default, so if you already run obsidian-brain from an MCP client you don't need a scheduled job at all — the index stays live as you edit.

If you want a dedicated daemon that keeps the index fresh without any MCP client running (useful on a server, or if you quit Claude Desktop between sessions), point a LaunchAgent at the `watch` subcommand:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.you.obsidian-brain-watch</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/obsidian-brain</string>
        <string>watch</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>VAULT_PATH</key>
        <string>/absolute/path/to/your/vault</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/obsidian-brain-watch.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/obsidian-brain-watch.err</string>
</dict>
</plist>
```

Save as `~/Library/LaunchAgents/com.you.obsidian-brain-watch.plist`, then:

```bash
launchctl load ~/Library/LaunchAgents/com.you.obsidian-brain-watch.plist
launchctl list | grep obsidian-brain-watch
```

`KeepAlive=true` restarts the process if it exits; `RunAtLoad=true` starts it immediately at login. Stop with `launchctl unload` on the same path. The rest of this document (the scheduled-index plist below) is the fallback if you set `OBSIDIAN_BRAIN_NO_WATCH=1` or your vault lives somewhere FSEvents can't observe.

## What it does (scheduled fallback)

This sets up a macOS LaunchAgent that runs `obsidian-brain index` every 30 minutes against your vault. The `index` command is incremental — it only re-embeds files whose mtime has changed since the last run — so each tick is cheap. There is no long-running daemon to manage: `launchd` owns the schedule and spawns the process when the timer fires.

## Prerequisites

- `npm install -g obsidian-brain` — puts the `obsidian-brain` binary on your `PATH`. Confirm with `which obsidian-brain`; note the path (typically `/opt/homebrew/bin/obsidian-brain` on macOS Homebrew).
- You know the absolute path to your vault (the value you pass as `VAULT_PATH`).

If you're running obsidian-brain from a local source clone instead of npm, see the [source install variant](#variant-running-from-a-local-clone) at the bottom of this file.

## The plist

Save this as `~/Library/LaunchAgents/com.you.obsidian-brain.plist`. Replace `/absolute/path/to/obsidian-brain` (from `which obsidian-brain`) and `/absolute/path/to/your/vault` with your real paths. The `Label` can be renamed to anything you like (it just needs to match the filename).

Note on `ProgramArguments`: `launchd` runs with a minimal `PATH`, so the binary must be specified by absolute path. The example below assumes Homebrew on Apple Silicon. On Intel Macs it's usually `/usr/local/bin/obsidian-brain`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.you.obsidian-brain</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/obsidian-brain</string>
        <string>index</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>VAULT_PATH</key>
        <string>/absolute/path/to/your/vault</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>StartInterval</key>
    <integer>1800</integer>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>/tmp/obsidian-brain-index.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/obsidian-brain-index.err</string>
</dict>
</plist>
```

## Save it

Write the file above to:

```bash
~/Library/LaunchAgents/com.you.obsidian-brain.plist
```

## Load it

```bash
launchctl load ~/Library/LaunchAgents/com.you.obsidian-brain.plist
launchctl list | grep obsidian-brain
```

The `list` output should show your label with a PID column (dash when idle) and an exit status column (`0` after a successful run).

## Reload after changes

Any edit to the plist requires an unload/load cycle — `launchd` caches the parsed plist in memory.

```bash
launchctl unload ~/Library/LaunchAgents/com.you.obsidian-brain.plist
launchctl load ~/Library/LaunchAgents/com.you.obsidian-brain.plist
```

## Check logs

```bash
tail -f /tmp/obsidian-brain-index.log
tail -f /tmp/obsidian-brain-index.err
```

`stdout` goes to `.log` (normal indexing output), `stderr` goes to `.err` (anything that went wrong).

## Adjusting the interval

`StartInterval` is in seconds. `1800` is 30 minutes; use `600` for 10 minutes, `3600` for hourly, etc. If you want the indexer to run once immediately when the agent is loaded (instead of waiting a full interval), flip `RunAtLoad` to `true`:

```xml
<key>RunAtLoad</key>
<true/>
```

Remember to unload and reload after any change.

## Disable temporarily

`unload` stops the schedule but leaves the plist on disk, so you can re-enable it later with `load`:

```bash
launchctl unload ~/Library/LaunchAgents/com.you.obsidian-brain.plist
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.you.obsidian-brain.plist
rm ~/Library/LaunchAgents/com.you.obsidian-brain.plist
```

## Troubleshooting

- **Exit code 78 in `launchctl list`.** Almost always a binary-path problem. Verify the path from `which obsidian-brain` exists (`ls -l $(which obsidian-brain)`) and matches what you put in `ProgramArguments`. If you re-installed node and your `obsidian-brain` symlink moved, re-run `npm install -g obsidian-brain`.
- **No reindex happening.** Check `/tmp/obsidian-brain-index.err` first. The most common cause is `VAULT_PATH` pointing at a folder that does not exist (for example, a typo or an iCloud path that is not downloaded).
- **`better-sqlite3` ABI / "was compiled against a different Node.js version" error.** The native module shipped with the npm package was built against a different `node` than the one on your system. Rebuild it in place:

  ```bash
  PATH=/opt/homebrew/bin:$PATH npm rebuild -g better-sqlite3
  ```

  Then unload and reload the agent.

## Variant: running from a local clone

If you're developing obsidian-brain from a source clone rather than the npm package, swap `ProgramArguments` to point at your local CLI. You'll also want a `WorkingDirectory` so the compiled `dist/` path resolves:

```xml
<key>WorkingDirectory</key>
<string>/absolute/path/to/obsidian-brain</string>
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/node</string>
    <string>dist/cli/index.js</string>
    <string>index</string>
</array>
```

Everything else (env vars, interval, logs) stays the same.
