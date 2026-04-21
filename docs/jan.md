# Wiring obsidian-brain into Jan

## TL;DR

Point Jan at the stdio server directly. It works. Don't use HTTP in Jan 0.7.x.

## Two-minute setup (UI path)

1. Open [Jan](https://jan.ai) and navigate to **Settings -> MCP Servers -> + Add**.
2. Fill in the fields:
   - **Name**: `obsidian-brain`
   - **Transport**: **STDIO (local process)**
   - **Command**: `/opt/homebrew/bin/node` on macOS (Homebrew), or `/usr/bin/node` on Linux. Use an absolute path, **not** `node`. Jan spawns subprocesses with a minimal `PATH` that usually doesn't include your shell's Node install, so a bare `node` will fail with `command not found` or pick up a stale system binary.
   - **Arguments**: `/absolute/path/to/obsidian-brain/dist/server.js`
   - **Environment variables**: `VAULT_PATH=/absolute/path/to/your/vault`
3. Save and enable the server. Jan will spawn the process and send `initialize` followed by `tools/list`. You should see the 13 obsidian-brain tools appear in the MCP panel.

## Config file path

If you'd rather edit JSON than click through the UI, Jan keeps MCP config here:

- **macOS**: `~/Library/Application Support/Jan/data/mcp_config.json`
- **Linux**: `~/.local/share/Jan/data/mcp_config.json`

The JSON shape is roughly:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/obsidian-brain/dist/server.js"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

**Caveat**: Jan's config-file schema is not publicly pinned and has shifted across point releases. Jan prefers the UI as the authoritative path for adding MCP servers. If the shape above stops working after a Jan upgrade, fall back to the UI flow and let Jan regenerate the file.

## Verify it works

Start a new chat in Jan and ask:

> List my obsidian-brain tools.

The assistant should respond naming all 13 tools:

- `search`
- `read_note`
- `list_notes`
- `find_connections`
- `find_path_between`
- `detect_themes`
- `rank_notes`
- `create_note`
- `edit_note`
- `link_notes`
- `move_note`
- `delete_note`
- `reindex`

Alternatively, open the Jan MCP panel — it lists the tools once `tools/list` succeeds.

## Why not HTTP?

Short version: Jan's HTTP MCP client has a bug that bites on the exact call pattern most MCP servers use. Stdio sidesteps it entirely.

Long version:

- Jan 0.7.x ships [`rmcp`](https://github.com/modelcontextprotocol/rust-sdk) (the Rust MCP SDK) as its client.
- `rmcp`'s `StreamableHttpClientTransport` has an open bug in its SSE frame parsing — see [rust-sdk issue #468](https://github.com/modelcontextprotocol/rust-sdk/issues/468). It reads the first SSE `data:` frame as the JSON-RPC response and then gets confused about stream lifetime when the server closes the HTTP response per-request.
- Most MCP servers that speak Streamable HTTP (including `aaronsb/obsidian-mcp-plugin`) return a response as a single SSE frame and then close the stream. That is correct per spec. It also trips the rmcp bug. The symptom: `initialize` succeeds, then `tools/list` dies with `Transport closed`, and the session never recovers.
- obsidian-brain avoids the whole problem: it is stdio-only. Newline-delimited JSON over pipes — no SSE frames, no stream lifetime to misparse. Jan's stdio client is a different code path without the bug.

**For Jan, always use stdio.** The fix will eventually land when Jan bumps its `rmcp` dependency past PR #467, but you don't need to wait.

## Troubleshooting

### Tools list is empty but Jan shows the server as connected

Usually this means the server crashed after `initialize`. Two ways to diagnose:

1. Check Jan's MCP server log: **Settings -> MCP Servers -> click the server -> View logs**.
2. Run the server by hand and watch stderr:

   ```bash
   VAULT_PATH="/absolute/path/to/your/vault" \
     /opt/homebrew/bin/node /absolute/path/to/obsidian-brain/dist/server.js
   ```

   Paste a single `initialize` frame on stdin and confirm you get a JSON-RPC response back.

### `command not found: node`

You used `node` instead of the absolute path. Replace with `/opt/homebrew/bin/node` (macOS Homebrew) or the output of `which node` on Linux.

### `Vault path not configured`

The `env` block in Jan's UI didn't stick. Open the server entry, re-enter `VAULT_PATH=/absolute/path/to/your/vault` exactly, and save.

### `better-sqlite3` ABI mismatch (`ERR_DLOPEN_FAILED`)

The native module was built against a different Node ABI than the one Jan launches. Rebuild against the same Node:

```bash
PATH=/opt/homebrew/bin:$PATH npm rebuild better-sqlite3
```

### Slow first call / Jan times out the first `reindex`

The 22MB embedding model downloads on first use. Jan may time out the first `reindex` tool call while the download happens. Run `reindex` once from the CLI first so the model is cached locally:

```bash
VAULT_PATH="/absolute/path/to/your/vault" \
  /opt/homebrew/bin/node /absolute/path/to/obsidian-brain/dist/cli/index.js index
```

After that, subsequent calls from Jan are fast.
