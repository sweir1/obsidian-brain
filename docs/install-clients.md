---
title: Install in your MCP client
description: Wire obsidian-brain into Claude Desktop, Cursor, VS Code, Jan, Claude Code, Cline, Zed, LM Studio, JetBrains, Opencode, Codex CLI, Gemini CLI, Warp, Windsurf, or anything else speaking MCP.
---

# Install in your MCP client

obsidian-brain is a **local, stdio-only** MCP server. No API key. No hosted endpoint. No remote URL. Your vault content never leaves your machine. Every snippet below runs the same process locally and differs only in how your client expects the config to be shaped.

Replace `/absolute/path/to/your/vault` everywhere with the real path to your vault.

On first boot the server auto-indexes the vault and downloads the default embedding model (~34 MB) — initial `tools/list` may block for 30–60 s, subsequent starts are instant.

> **Embedding preset knob.** Any config below accepts `EMBEDDING_PRESET` in its `env` block as an optional upgrade. Valid values: `english` (default), `english-fast`, `english-quality`, `multilingual`, `multilingual-quality`, `multilingual-ollama`. (`fastest` and `balanced` are deprecated aliases that resolve to `english-fast` / `english` respectively and emit a one-time stderr warning.) Example: add `"EMBEDDING_PRESET": "multilingual"` alongside `VAULT_PATH` to switch to a multilingual model. See [Models](models.md) for the full preset table, MTEB ranking, and BYOM recipes.

> **Auto-update.** Every snippet below uses `obsidian-brain@latest` — the `@latest` tag forces npx to re-resolve the newest published version on every launch so future releases auto-propagate after a client restart. Drop `@latest` (or pin to e.g. `obsidian-brain@1.6.0`) if you'd rather cache a known-good version and update on your own schedule.

No system-level prerequisites beyond Node 20+. `npm install` bundles every native binding — `better-sqlite3` (with its own statically-linked SQLite build), the `sqlite-vec` extension, and the ONNX runtime for local embeddings — as prebuilt binaries for macOS, Linux, and Windows. You don't need `brew install sqlite`, Xcode Command Line Tools, or Python unless you land in the rare case where no prebuilt matches your Node version (see [Troubleshooting → ERR_DLOPEN_FAILED](troubleshooting.md#err_dlopen_failed-node_module_version-mismatch)).

??? info "Claude Desktop"

    Open the config file (create it if missing):

    - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
    - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

    Or from the app: **Settings → Developer → Edit Config**. Add under `mcpServers`:

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

    Fully quit Claude Desktop (⌘Q on macOS) and relaunch. If it can't find `npx`, swap for the absolute path (`/opt/homebrew/bin/npx` on macOS Homebrew). [Claude Desktop MCP quickstart](https://modelcontextprotocol.io/quickstart/user).

??? info "Claude Code"

    ```bash
    claude mcp add --scope user --transport stdio obsidian-brain \
      -e VAULT_PATH="$HOME/path/to/your/vault" \
      -- npx -y obsidian-brain@latest server
    ```

    All flags (`--scope`, `--transport`, `-e`) come before the server name. `--` separates the name from the launch command. To raise the startup timeout for the first-boot auto-index, prefix the `claude` CLI with `MCP_TIMEOUT=60000`. [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

??? info "Cursor"

    Fastest: **Cursor Settings → MCP → Add new MCP server**. Or edit `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (project):

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

    Reload Cursor; the server appears under Settings → MCP with its 18 tools. [Cursor MCP docs](https://cursor.com/docs/context/mcp).

??? info "VS Code (GitHub Copilot)"

    VS Code 1.102+ with Copilot. CLI:

    ```bash
    code --add-mcp '{"name":"obsidian-brain","command":"npx","args":["-y","obsidian-brain@latest","server"],"env":{"VAULT_PATH":"/absolute/path/to/your/vault"}}'
    ```

    Or create `.vscode/mcp.json` in your workspace (note: top-level key is `servers`, with `type: "stdio"`):

    ```json
    {
      "servers": {
        "obsidian-brain": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "obsidian-brain@latest", "server"],
          "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
        }
      }
    }
    ```

    Open Copilot Chat in **Agent** mode. [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

??? info "Windsurf"

    Cascade → **MCP** icon (top right) → **Manage MCPs** → **View raw config**, or edit `~/.codeium/windsurf/mcp_config.json`:

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

    Click **Refresh** in the MCP panel (no full Windsurf restart needed). [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp).

??? info "Jan"

    **Settings → MCP Servers → + Add**. Transport: `STDIO (local process)`. Command: `npx` (or absolute path if Jan can't find it). Arguments: `-y`, `obsidian-brain@latest`, `server`. Env: `VAULT_PATH=/absolute/path/to/your/vault`. Save and toggle on.

    Jan places server entries at the top level of its MCP config — there is no `mcpServers` wrapper, unlike Claude Desktop.

    Equivalent JSON (Jan writes this itself under `~/Library/Application Support/Jan/data/mcp_config.json` on macOS, `~/.config/Jan/data/mcp_config.json` on Linux, `%APPDATA%\Jan\data\mcp_config.json` on Windows):

    ```json
    {
      "obsidian-brain": {
        "command": "npx",
        "args": ["-y", "obsidian-brain@latest", "server"],
        "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
      }
    }
    ```

    **Use STDIO, not HTTP.** Jan 0.7.x's rmcp client has an open bug with Streamable-HTTP that kills `tools/list` right after `initialize` ([rust-sdk#468](https://github.com/modelcontextprotocol/rust-sdk/issues/468)). obsidian-brain is stdio-only anyway, but don't wrap it in an HTTP proxy for Jan or you'll trip the bug. Full walkthrough: [Jan integration](jan.md).

??? info "Cline"

    Click the MCP Servers icon in Cline's nav bar → **Installed** → **Configure MCP Servers** to open `cline_mcp_settings.json`. Paste:

    ```json
    {
      "mcpServers": {
        "obsidian-brain": {
          "command": "npx",
          "args": ["-y", "obsidian-brain@latest", "server"],
          "env": { "VAULT_PATH": "/absolute/path/to/your/vault" },
          "disabled": false,
          "autoApprove": []
        }
      }
    }
    ```

    On Windows, swap to `"command": "cmd"`, `"args": ["/c", "npx", "-y", "obsidian-brain@latest", "server"]` so `npx.cmd` is resolved. [Cline MCP docs](https://docs.cline.bot/mcp/configuring-mcp-servers).

??? info "Zed"

    Agent Panel → settings gear → **Add Custom Server**, or edit `~/.config/zed/settings.json` directly (`%APPDATA%\Zed\settings.json` on Windows). Zed uses `context_servers` with `"source": "custom"`:

    ```json
    {
      "context_servers": {
        "obsidian-brain": {
          "source": "custom",
          "command": "npx",
          "args": ["-y", "obsidian-brain@latest", "server"],
          "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
        }
      }
    }
    ```

    A green dot next to the server in the Agent Panel means it's live. [Zed MCP docs](https://zed.dev/docs/ai/mcp).

??? info "LM Studio"

    Right sidebar → **Program** tab → **Install** → **Edit mcp.json** (`~/.lmstudio/mcp.json` on macOS/Linux, `%USERPROFILE%\.lmstudio\mcp.json` on Windows):

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

    LM Studio spawns the server automatically on save. [LM Studio MCP docs](https://lmstudio.ai/docs/app/plugins/mcp).

??? info "JetBrains AI Assistant"

    IntelliJ / PyCharm / WebStorm 2025.1+ with AI Assistant 251.26094.80.5+. **Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → As JSON**:

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

    Pick Global or Project scope, enable the row; the Status column turns green when the stdio subprocess is live. [JetBrains MCP docs](https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html).

??? info "Opencode"

    Add to `opencode.json` (project root) or `~/.config/opencode/opencode.json` (global). Note the shape: top-level `mcp`, `type: "local"`, `command` is an array, env lives under `environment`:

    ```json
    {
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
        "obsidian-brain": {
          "type": "local",
          "command": ["npx", "-y", "obsidian-brain@latest", "server"],
          "enabled": true,
          "environment": { "VAULT_PATH": "/absolute/path/to/your/vault" }
        }
      }
    }
    ```

    [Opencode MCP docs](https://opencode.ai/docs/mcp-servers).

??? info "OpenAI Codex CLI"

    ```bash
    codex mcp add obsidian-brain --env VAULT_PATH="$HOME/path/to/your/vault" -- npx -y obsidian-brain@latest server
    ```

    Then bump the startup timeout in `~/.codex/config.toml` — the default 10 s is too short for first-boot auto-indexing:

    ```toml
    [mcp_servers.obsidian-brain]
    command = "npx"
    args = ["-y", "obsidian-brain@latest", "server"]
    startup_timeout_sec = 60

    [mcp_servers.obsidian-brain.env]
    VAULT_PATH = "/absolute/path/to/your/vault"
    ```

    [Codex MCP docs](https://developers.openai.com/codex/mcp).

??? info "Gemini CLI"

    No `mcp add` subcommand — edit `~/.gemini/settings.json` and merge into `mcpServers`:

    ```json
    {
      "mcpServers": {
        "obsidian-brain": {
          "command": "npx",
          "args": ["-y", "obsidian-brain@latest", "server"],
          "env": { "VAULT_PATH": "$HOME/path/to/your/vault" },
          "timeout": 60000
        }
      }
    }
    ```

    Gemini expands `$VAR` inside the `env` block; `timeout` is in milliseconds. [Gemini CLI MCP docs](https://www.geminicli.com/docs/tools/mcp-server).

??? info "Warp"

    **Settings → AI → Manage MCP servers → + Add → CLI Server (Command)**. Paste:

    ```json
    {
      "obsidian-brain": {
        "command": "npx",
        "args": ["-y", "obsidian-brain@latest", "server"],
        "env": { "VAULT_PATH": "/absolute/path/to/your/vault" },
        "working_directory": null
      }
    }
    ```

    Warp launches the command on startup and shuts it down on exit. [Warp MCP docs](https://docs.warp.dev/agent-platform/warp-agents/agent-context/mcp).

??? info "Any other client"

    The common shape across almost every client is:

    ```json
    {
      "command": "npx",
      "args": ["-y", "obsidian-brain@latest", "server"],
      "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
    }
    ```

    Wrap it in whatever top-level key your client expects (`mcpServers`, `servers`, `mcp`, `context_servers`, etc.). No API key, no remote URL, no auth header — none of that applies to a local stdio server.

    On Windows, if `npx` isn't found, swap `"command": "npx"` for `"command": "cmd"` and prepend `/c` to the args: `["/c", "npx", "-y", "obsidian-brain@latest", "server"]`.

## Verifying the connection

Once your client restarts, obsidian-brain should appear in its MCP/tool list with 18 tools. Try:

> *"Use `search` to find notes about the most recent thing I wrote."*

If nothing happens, check [Troubleshooting](troubleshooting.md) — most first-run issues are solved in two lines.
