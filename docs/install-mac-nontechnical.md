---
title: macOS setup (non-technical)
description: Step-by-step walkthrough for installing obsidian-brain on macOS — covers Homebrew, Node, the GUI-app PATH fix, and Full Disk Access. No prior Terminal experience needed.
---

# macOS setup (non-technical)

If you're comfortable with Node/npm, the [Quick start](getting-started.md) is shorter. This guide walks through every step including the macOS-specific permissions that trip up most first installs.

## Step 1 — Open Terminal

Press **⌘ Space** to open Spotlight, type **Terminal**, then press **Enter**.

**You should see** a window with a `$` or `%` prompt.

## Step 2 — Install Homebrew

Paste this into Terminal and press Enter:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

The script will ask for your macOS password (normal — it needs admin access). When it finishes it prints two **"Next steps"** commands starting with `echo >>`. **Run both of those lines verbatim** — they add Homebrew to your shell's PATH.

Verify:

```bash
brew --version
```

**You should see** `Homebrew X.Y.Z` printed.

## Step 3 — Install Node 20+

```bash
brew install node
```

Verify:

```bash
node -v
```

**You should see** `v20.x.x` or higher.

## Step 4 — Symlink node into `/usr/local/bin`

!!! note "Why this step is needed"
    Claude Desktop and Jan.ai are GUI apps — they launch with a minimal PATH that includes `/usr/local/bin` but **not** `/opt/homebrew/bin`, so they can't find the `node` Homebrew installed. These two symlinks fix that.

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf "$(which node)" /usr/local/bin/node
sudo ln -sf "$(which npx)" /usr/local/bin/npx
```

You'll be asked for your password again. Verify:

```bash
/usr/local/bin/node -v
```

**You should see** the same version number as in Step 3.

## Step 5 — Put the config in the right file

### Claude Desktop

Open this file (create it if it doesn't exist):

`~/Library/Application Support/Claude/claude_desktop_config.json`

Paste the following, replacing `/absolute/path/to/your/vault` with the real path to your vault folder:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

> **Tip:** You can drag a folder into Terminal to get its absolute path — it'll paste the full path for you.

### Jan

Jan's settings UI has an MCP section — enter the server as a new entry there. Jan's config shape is different from Claude Desktop (no `mcpServers` wrapper). See [Jan integration](jan.md) for details.

## Step 6 — Grant Full Disk Access

!!! note "Why this step is needed"
    macOS restricts apps from reading folders outside their sandbox. Claude Desktop and Jan need permission to read your vault and to download the embedding model on first launch. Granting access to the specific vault folder is *not* sufficient — the model downloads to a cache path that falls outside any per-folder grant.

1. Open **Apple menu → System Settings → Privacy & Security → Full Disk Access**.
2. Toggle **Claude Desktop** on (and **Jan** if you use it).
3. Quit and relaunch the app.

<!-- TODO screenshot -->

**You should see** Claude Desktop and Jan in the Full Disk Access list with their toggles ON.

## Step 7 — Restart the client and wait

Quit the app fully with **⌘ Q** (closing the window is not enough — the background process keeps running). Then relaunch.

On first boot the server downloads the embedding model (~34 MB) and indexes your vault. This takes 30–60 seconds.

**You should see** obsidian-brain's tools appear in the client within 30–60 seconds.

## Step 8 — If something went wrong

Check these troubleshooting sections:

- [Claude Desktop / Jan can't find node or npx](troubleshooting.md#claude-desktop-jan-cant-find-node-or-npx)
- [macOS: vault reads fail or the embedding-model download hangs silently](troubleshooting.md#macos-vault-reads-fail-or-the-embedding-model-download-hangs-silently)
- [npx is launching an old version](troubleshooting.md#npx-is-launching-an-old-version)
- [The embedding-model cache looks corrupt](troubleshooting.md#the-embedding-model-cache-looks-corrupt)
