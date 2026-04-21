# macOS LaunchAgent setup

## What it does

This sets up a macOS LaunchAgent that runs `node dist/cli/index.js index` every 30 minutes against your vault. The `index` command is incremental — it only re-embeds files whose mtime has changed since the last run — so each tick is cheap. There is no long-running daemon to manage: `launchd` owns the schedule and spawns the process when the timer fires.

## Prerequisites

- The repo is cloned locally.
- You have run `npm install` and `npm run build` so `dist/cli/index.js` exists.
- You know the absolute path to your vault (the value you pass as `VAULT_PATH`).

## The plist

Save this as `~/Library/LaunchAgents/com.you.obsidian-brain.plist`. Replace `<your-username>`, `/absolute/path/to/obsidian-brain`, and `/absolute/path/to/your/vault` with your real paths. The `Label` can be renamed to anything you like (it just needs to match the filename).

Note on `ProgramArguments`: `launchd` runs with a minimal `PATH`, so `node` must be specified by absolute path. The example below assumes Homebrew on Apple Silicon (`/opt/homebrew/bin/node`). On Intel Macs it is usually `/usr/local/bin/node`. Run `which node` to confirm.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.you.obsidian-brain</string>

    <key>WorkingDirectory</key>
    <string>/absolute/path/to/obsidian-brain</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>dist/cli/index.js</string>
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

- **Exit code 78 in `launchctl list`.** Almost always a Node path problem. Verify `/opt/homebrew/bin/node` exists (`ls -l /opt/homebrew/bin/node`) and update `ProgramArguments` to match your actual `which node` output.
- **No reindex happening.** Check `/tmp/obsidian-brain-index.err` first. The most common cause is `VAULT_PATH` pointing at a folder that does not exist (for example, a typo or an iCloud path that is not downloaded). The second most common is `WorkingDirectory` not matching where `dist/cli/index.js` actually lives.
- **`better-sqlite3` ABI / "was compiled against a different Node.js version" error.** The native module was built against a different `node` than the one `launchd` is invoking. Rebuild it against the Homebrew node:

  ```bash
  PATH=/opt/homebrew/bin:$PATH npm rebuild better-sqlite3
  ```

  Then unload and reload the agent.
