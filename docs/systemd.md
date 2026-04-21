# Linux systemd user timer

Keep your obsidian-brain index fresh on Linux by running `obsidian-brain index` every 30 minutes via a systemd **user** timer. No root, no system-wide install.

## What it does

A systemd user timer runs `obsidian-brain index` every 30 minutes as your user account. Because everything lives under `~/.config/systemd/user/`, there is no sudo required and nothing is installed system-wide. The timer is tied to your login session and will stop when you log out — unless you enable `linger` (see the optional step below).

## Prerequisites

- `npm install -g obsidian-brain` — puts the `obsidian-brain` binary on your `PATH`. Confirm with `which obsidian-brain` and note the path (commonly `/usr/bin/obsidian-brain`, `/usr/local/bin/obsidian-brain`, or an nvm-scoped variant).
- You know the absolute path to your Obsidian vault (`VAULT_PATH`).
- A systemd-based Linux distribution (most modern distros: Ubuntu, Debian, Fedora, Arch, openSUSE, etc.).

If you're running from a local source clone instead of npm, see the [source install variant](#variant-running-from-a-local-clone) at the bottom of this file.

## 1. Create the service unit

Create `~/.config/systemd/user/obsidian-brain.service`:

```ini
[Unit]
Description=obsidian-brain vault reindex
After=network.target

[Service]
Type=oneshot
Environment=VAULT_PATH=/absolute/path/to/your/vault
ExecStart=/usr/bin/obsidian-brain index
StandardOutput=append:%h/.local/state/obsidian-brain-index.log
StandardError=append:%h/.local/state/obsidian-brain-index.err
```

Notes:

- `%h` is expanded by systemd to your `$HOME` directory.
- Adjust `/usr/bin/obsidian-brain` to match wherever `which obsidian-brain` reports on your system. If you installed node via `nvm`, the binary will be under `/absolute/path/to/.nvm/versions/node/vXX.Y.Z/bin/obsidian-brain` — use that full path; systemd does **not** expand `~` inside `ExecStart`.
- `Type=oneshot` is correct here: the reindex runs to completion and exits; the timer will trigger the next run.

## 2. Create the timer unit

Create `~/.config/systemd/user/obsidian-brain.timer`:

```ini
[Unit]
Description=Run obsidian-brain reindex every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Unit=obsidian-brain.service
Persistent=true

[Install]
WantedBy=timers.target
```

What these fields mean:

- `OnBootSec=5min` — wait 5 minutes after the user manager starts before the first run, so login isn't slowed by indexing.
- `OnUnitActiveSec=30min` — after each run finishes, wait 30 minutes before firing the next one.
- `Persistent=true` — if the machine was off or asleep when a run was supposed to fire, systemd will run it as soon as possible after resume / boot. Without this, missed runs are simply skipped.

## 3. Enable and start

```bash
mkdir -p ~/.local/state
systemctl --user daemon-reload
systemctl --user enable --now obsidian-brain.timer
systemctl --user list-timers --all | grep obsidian-brain
```

The last command should print a row showing `obsidian-brain.timer` along with its `NEXT` and `LEFT` columns.

## 4. Optional — survive logout

By default, user services stop when you log out. On a desktop that's usually fine. On a server, or if you want indexing to continue after logging out of a graphical session, enable linger for your user:

```bash
sudo loginctl enable-linger $USER
```

This is the one step in the whole guide that needs sudo, and it's optional.

## 5. Check status and logs

```bash
systemctl --user status obsidian-brain.service
systemctl --user status obsidian-brain.timer
journalctl --user -u obsidian-brain.service -n 50
tail -f ~/.local/state/obsidian-brain-index.log
```

`journalctl` shows systemd's view of every execution (exit codes, timings). The log file captures the indexer's stdout; the `.err` file captures stderr.

## 6. Trigger a run manually

Useful for verifying the unit works without waiting for the timer:

```bash
systemctl --user start obsidian-brain.service
```

Then check the log file or `journalctl` to confirm it ran.

## 7. Adjust the interval

Edit `~/.config/systemd/user/obsidian-brain.timer`, change `OnUnitActiveSec` to whatever you want (for example `15min`, `1h`, `6h`), then reload:

```bash
systemctl --user daemon-reload
systemctl --user restart obsidian-brain.timer
```

## 8. Disable and uninstall

```bash
systemctl --user disable --now obsidian-brain.timer
rm ~/.config/systemd/user/obsidian-brain.service
rm ~/.config/systemd/user/obsidian-brain.timer
systemctl --user daemon-reload
```

Log files under `~/.local/state/` are left in place — remove them manually if you want.

## 9. Troubleshooting

- **`status=203/EXEC`** — systemd could not execute the binary. Usually the path in `ExecStart` is wrong. Run `which obsidian-brain` and put that exact absolute path into the unit file, then `systemctl --user daemon-reload` and try again.
- **nvm users** — always use the fully expanded absolute path (for example `/absolute/path/to/.nvm/versions/node/v20.11.1/bin/obsidian-brain`). systemd does **not** expand `~` inside `ExecStart`, so paths like `~/.nvm/...` will fail with 203/EXEC.
- **Timer not firing** — `systemctl --user list-timers` must show `obsidian-brain.timer` with a real `NEXT` time. If it doesn't appear, re-run `systemctl --user enable --now obsidian-brain.timer`. If `NEXT` is `n/a`, double-check the `[Timer]` section syntax.
- **`better-sqlite3` native-module errors** — the native binding must be built against the same node version systemd will invoke. Rebuild it with that node on your `PATH`:

  ```bash
  PATH=/absolute/path/to/node/bin:$PATH npm rebuild -g better-sqlite3
  ```

- **Environment looks empty** — systemd user services start with a minimal environment. If your indexer needs extra variables beyond `VAULT_PATH`, add more `Environment=KEY=VALUE` lines to the `[Service]` section, one per line.

## Variant: running from a local clone

If you're developing obsidian-brain from a source clone rather than the npm package, your `[Service]` section needs both a `WorkingDirectory` and a `node dist/cli/index.js index` invocation:

```ini
[Service]
Type=oneshot
WorkingDirectory=/absolute/path/to/obsidian-brain
Environment=VAULT_PATH=/absolute/path/to/your/vault
ExecStart=/usr/bin/node dist/cli/index.js index
StandardOutput=append:%h/.local/state/obsidian-brain-index.log
StandardError=append:%h/.local/state/obsidian-brain-index.err
```

Everything else (timer unit, enable/start flow, troubleshooting) stays identical.
