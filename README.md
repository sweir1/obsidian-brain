# obsidian-brain

A standalone Node MCP server that gives Claude (or any MCP client) **semantic search + knowledge graph + vault editing** over an Obsidian vault — with **no Obsidian plugin required** and no HTTP bridge.

Built by merging the most useful parts of [`obra/knowledge-graph`](https://github.com/obra/knowledge-graph) (retrieval + graph) and [`aaronsb/obsidian-mcp-plugin`](https://github.com/aaronsb/obsidian-mcp-plugin) (vault editing), reimplemented as one standalone Node process that reads + writes the vault directly from disk.

## Quick start

From `git clone` to a queryable index in five commands:

```bash
git clone https://github.com/sweir1/obsidian-brain.git
cd obsidian-brain
npm install
npm run build
VAULT_PATH="$HOME/path/to/vault" node dist/cli/index.js index
```

The first `index` run downloads a ~22 MB embedding model (one-time) and then embeds + indexes every `.md` file under `VAULT_PATH`. Re-runs are incremental — only files whose mtime changed get re-embedded.

Verify the index:

```bash
VAULT_PATH="$HOME/path/to/vault" node dist/cli/index.js search "some query"
```

To plug it into Claude Desktop or Claude Code, see [Wiring into Claude Desktop](#wiring-into-claude-desktop) and [Wiring into Claude Code](#wiring-into-claude-code).

## Why this exists

Two existing MCP servers cover similar ground:

1. **`obra/knowledge-graph`** — excellent semantic retrieval + graph analytics, but read-heavy and a little clunky tool-wise.
2. **`aaronsb/obsidian-mcp-plugin`** — rich write/edit capability, but lives inside Obsidian and only works while Obsidian is open.

Running them side-by-side works but:

- Tools overlap — Claude picks the wrong one without careful routing instructions.
- Obsidian-plugin half dies whenever Obsidian is closed.
- Fourteen `kg_*` tools plus eight vault tool-groups is more surface area than any one workflow needs.

`obsidian-brain` solves this by unifying both into one stdio MCP server. Trade-offs: you lose Dataview, Bases, and live-workspace features that required the Obsidian API. You keep everything else, plus predictable routing and a single process.

## What you get

### One process, one config

Plain stdio MCP server. Works whether or not Obsidian is running. Writes land on disk; Obsidian picks them up on its own rescan.

### Incremental index with mtime tracking

Re-indexing only touches files whose modification time changed since last run. A launchd/systemd timer every ~30 min is enough for most vaults.

## Tool reference

13 tools, grouped by intent. Each tool includes a one-line Claude prompt you can copy-paste to nudge routing in the right direction.

### Find stuff

- **`search`** — Find notes by meaning (semantic) or by exact text (full-text).
  > *"Use `search` to find notes semantically about supply-chain tax."*
- **`list_notes`** — List notes, optionally filtered by directory or tag.
  > *"Use `list_notes` to list every note under `Projects/` tagged `#active`."*
- **`read_note`** — Read a note's metadata (and optionally full body). Fuzzy-matches filenames.
  > *"Use `read_note` to open the note called 'Q4 planning' and include the full content."*

### Understand the graph

- **`find_connections`** — N-hop link neighborhood around a note. Optional full subgraph.
  > *"Use `find_connections` to show everything within 2 hops of `Epistemology.md`."*
- **`find_path_between`** — Shortest link chain(s) between two notes. Optional shared-neighbors.
  > *"Use `find_path_between` to find how `Bayesian updating` connects to `Kelly criterion`."*
- **`detect_themes`** — Auto-detected topic clusters via Louvain community detection.
  > *"Use `detect_themes` to surface the main themes across my vault."*
- **`rank_notes`** — Top notes by influence (PageRank) or bridging (betweenness centrality).
  > *"Use `rank_notes` to list the top 10 most-linked-to notes by PageRank."*

### Write stuff

- **`create_note`** — Create a new note with frontmatter and auto-index it.
  > *"Use `create_note` to create `Meetings/2026-04-21 standup.md` with tags `[meeting, standup]`."*
- **`edit_note`** — Modify an existing note: append / prepend / window / patch-heading / patch-frontmatter / at-line.
  > *"Use `edit_note` to append a 'Follow-ups' section to today's standup note."*
- **`link_notes`** — Add a wiki-link between two notes plus a "why this connects" context sentence.
  > *"Use `link_notes` to link `Bayesian updating` to `Kelly criterion` with a note about risk-adjusted bets."*
- **`move_note`** — Rename or move a note; edges stay intact.
  > *"Use `move_note` to move `Inbox/thought.md` into `Areas/Ideas/thought.md`."*
- **`delete_note`** — Delete a note; requires `confirm: true`.
  > *"Use `delete_note` with `confirm: true` to delete `Inbox/obsolete.md`."*

### Maintenance

- **`reindex`** — Force a full re-index. Normally auto-run on a launchd/systemd timer.
  > *"Use `reindex` to refresh the index after I bulk-edited files outside Claude."*

## How it works

```
┌──────────────────────┐     stdio JSON-RPC     ┌──────────────────────────┐
│                      │ ─────────────────────► │                          │
│   MCP client         │                        │  obsidian-brain          │
│   (Claude Desktop,   │ ◄───────────────────── │  (Node process)          │
│    Claude Code,      │                        │                          │
│    your own)         │                        │  ┌────────────────────┐  │
│                      │                        │  │ SQLite index       │  │
└──────────────────────┘                        │  │  - nodes / edges   │  │
                                                │  │  - FTS5            │  │
                                                │  │  - vec0 embeddings │  │
                                                │  └────────────────────┘  │
                                                │            │             │
                                                │            ▼             │
                                                │  ┌────────────────────┐  │
                                                │  │ Vault on disk      │  │
                                                │  │  (your .md files)  │  │
                                                │  └────────────────────┘  │
                                                └──────────────────────────┘
```

- **Retrieval** (`search`, `read_note`, `find_connections`, etc.) is served from the SQLite index in microseconds.
- **Writes** (`create_note`, `edit_note`, `link_notes`, etc.) go straight to `.md` files on disk, then incrementally re-index the affected file.
- **Embeddings** use [Xenova's local port of all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — 384 dimensions, ~22 MB model, runs fully local with no API calls.

Why stdio, why SQLite, why incremental mtime sync, and the rmcp/SSE bug class obsidian-brain sidesteps: [docs/architecture.md](docs/architecture.md).

## Install

Prerequisites:
- Node 20+
- An Obsidian vault (or any folder of `.md` files — Obsidian itself is optional)

See [Quick start](#quick-start) above for the five-command install.

Optional: copy `.env.example` to `.env` if you'd rather configure `VAULT_PATH` via a dotenv file than the shell:

```bash
cp .env.example .env
# edit .env — set VAULT_PATH to your vault's absolute path
```

## Wiring into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Linux/Windows:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/obsidian-brain/dist/server.js"
      ],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

Notes:
- Use the absolute path to `node` because Claude Desktop launches subprocesses with a minimal PATH. On macOS with Homebrew: `/opt/homebrew/bin/node`.
- Quit Claude Desktop fully (⌘Q on macOS) and relaunch to pick up the new config.

## Wiring into Claude Code

Add a `.mcp.json` at your repo root, or use the `claude mcp add` CLI:

```bash
claude mcp add obsidian-brain \
  --scope user \
  -e VAULT_PATH="$HOME/path/to/your/vault" \
  -- node /absolute/path/to/obsidian-brain/dist/server.js
```

## Wiring into Jan

Jan speaks stdio MCP natively. In Jan: Settings → MCP Servers → **+ Add**, then:

- **Transport**: `STDIO (local process)`
- **Command**: `/opt/homebrew/bin/node` (macOS Homebrew) or `/usr/bin/node` (Linux)
- **Args**: `/absolute/path/to/obsidian-brain/dist/server.js`
- **Env**: `VAULT_PATH=/absolute/path/to/your/vault`

Save + enable. Jan will spawn the process and populate the tool list.

**Do not use Jan's HTTP transport** for any MCP server in Jan 0.7.x — `rmcp` (Jan's Rust MCP client) has an open bug parsing SSE frames from Streamable-HTTP servers ([rust-sdk#468](https://github.com/modelcontextprotocol/rust-sdk/issues/468)) which kills `tools/list` after a successful `initialize`. obsidian-brain is stdio-only by design, so this bug can't touch it.

Full walkthrough + troubleshooting: [docs/jan.md](docs/jan.md).

## Scheduled re-indexing

The server doesn't watch for file changes — it relies on a scheduled CLI run to keep the index fresh. On macOS use a LaunchAgent; on Linux a systemd user timer; on Windows Task Scheduler.

Example LaunchAgent (`~/Library/LaunchAgents/com.you.obsidian-brain.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.obsidian-brain</string>
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
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.you.obsidian-brain.plist
```

Full macOS walkthrough: [docs/launchd.md](docs/launchd.md). Linux systemd user-timer setup: [docs/systemd.md](docs/systemd.md).

## Configuration

All config is via environment variables:

| Variable | Required? | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | **yes** | — | Absolute path to the vault (folder of `.md` files). |
| `DATA_DIR` | no | `$XDG_DATA_HOME/obsidian-brain` or `$HOME/.local/share/obsidian-brain` | Where the SQLite index + embedding cache live. |
| `EMBEDDING_MODEL` | no | `Xenova/all-MiniLM-L6-v2` | Hugging Face transformers-js model. Must be a sentence-embedding model that outputs a single vector. |

`KG_VAULT_PATH` is accepted as a legacy alias for `VAULT_PATH`.

## Troubleshooting

Common issues below. Long-form walkthrough with more edge cases: [docs/troubleshooting.md](docs/troubleshooting.md).


- **"Connector has no tools available"** in Claude Desktop — usually means the MCP server crashed at startup, often due to a stale `dist/` built against a different Zod (or other dep) version. Run `npm run build` to rebuild, then fully quit (⌘Q) and relaunch Claude Desktop.
- **`ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch** — `better-sqlite3` was built against a different Node ABI than the one running the server. Rebuild the native module against the Node you actually launch with:
  ```bash
  PATH=/opt/homebrew/bin:$PATH npm rebuild better-sqlite3
  ```
- **Slow first run** — the 22 MB `all-MiniLM-L6-v2` embedding model downloads on first use and caches under `DATA_DIR`. Subsequent runs are fast.
- **`Vault path not configured`** — `VAULT_PATH` isn't set. Export it in your shell, put it in `.env`, or set it in the `env` block of your Claude Desktop / Claude Code config. `KG_VAULT_PATH` also works as a legacy alias.
- **Index stale after a manual edit outside Claude** — the launchd/systemd timer re-indexes every 30 min by default. To refresh on demand, either call the `reindex` MCP tool from your client or run the CLI: `VAULT_PATH=... node dist/cli/index.js index`.

## Development

Repo layout (key directories under `src/`):

```
obsidian-brain/
├── src/
│   ├── server.ts              # MCP server bootstrap
│   ├── cli/index.ts           # `obsidian-brain` CLI
│   ├── config.ts              # env parsing
│   ├── tools/                 # one file per MCP tool
│   ├── store/                 # SQLite schema + CRUD
│   ├── embeddings/            # Xenova model wrapper
│   ├── graph/                 # graphology + analytics
│   ├── vault/                 # read/write/edit .md files
│   ├── search/                # semantic + FTS
│   ├── resolve/               # fuzzy note-name matching
│   └── pipeline/              # indexing orchestrator
├── test/                      # vitest
├── scripts/                   # smoke tests + dev helpers
└── dist/                      # tsc output (gitignored)
```

Every source file targets <200 lines and has a single concern.

Common commands:

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm test` | Run vitest unit tests. |
| `npm run smoke` | End-to-end MCP smoke test against a throwaway temp vault. |
| `npm run dev` | Run the server directly via `tsx` (no build step — handy for iteration). |

## What it does *not* do (yet)

- No Dataview query execution (would require a running Obsidian + Dataview plugin).
- No Obsidian Bases support (same reason).
- No live-workspace / active-editor awareness (needs Obsidian's API).
- No file watcher — indexing is on-demand / timer-driven.
- No hybrid cloud embeddings — all local, no API calls.

If any of those matter to you, use `obsidian-brain` alongside the aaronsb plugin for the Obsidian-API bits; they're complementary, not exclusive.

## Credits

- [obra/knowledge-graph](https://github.com/obra/knowledge-graph) — the SQLite + graph + embedding stack we ported wholesale.
- [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) — the edit-operation design (window / patch / at-line) we reimplemented on plain FS.
- [Xenova/transformers.js](https://github.com/xenova/transformers.js) — local sentence embeddings.
- [graphology](https://graphology.github.io/) — graph + centrality + community detection.
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — vector search inside SQLite.

## License

MIT.
