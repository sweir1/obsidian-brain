# Companion Obsidian plugin

`obsidian-brain` works against your vault's files on disk. Three kinds of data, however, **only exist inside a running Obsidian process**: Dataview DQL query results, Obsidian Bases view rows, and active-editor state (what note is open, cursor position). These require a small companion plugin that runs inside Obsidian.

Repo: [`sweir1/obsidian-brain-plugin`](https://github.com/sweir1/obsidian-brain-plugin).

## What it does

On plugin load:

1. Binds an HTTP server to `127.0.0.1` on a configurable port (default `27125`).
2. Generates a random bearer token (regenerated every startup, never persisted).
3. Writes `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt}`.

`obsidian-brain server` reads the discovery file based on `VAULT_PATH`, authenticates every request with the token, and re-reads discovery on any 401 or ECONNREFUSED (so a plugin restart that rotated the token doesn't wedge the MCP tools).

## Install

### Via BRAT (while in pre-release)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In Obsidian: `BRAT: Add a beta plugin for testing` → enter `sweir1/obsidian-brain-plugin`.
3. Enable `obsidian-brain companion` under Settings → Community plugins.

### Manual

Download `main.js` + `manifest.json` from the [latest release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest), drop them into `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`, reload Obsidian, enable under Community plugins.

## Which tools require it

| Tool | Needs plugin? | Notes |
|---|---|---|
| `active_note` (v1.2.0+) | yes | Returns the path + cursor + selection of the note currently open in Obsidian. |
| `dataview_query` (planned, v1.3.0) | yes | Runs a DQL query via the Dataview plugin. |
| `base_query` (planned, v1.4.0) | yes | Evaluates an Obsidian Bases `.base` file. |

Every other tool (`search`, `read_note`, `list_notes`, `find_connections`, `find_path_between`, `detect_themes`, `rank_notes`, `create_note`, `edit_note`, `link_notes`, `move_note`, `delete_note`, `reindex`) works standalone with or without the plugin.

When the plugin is absent or unreachable, the plugin-dependent tools return an error containing the install instructions verbatim — the rest of the server keeps working normally.

## Security

- Localhost-only (`127.0.0.1`). Never binds to a LAN interface.
- Bearer token required on every request. Random 32-byte hex, regenerated on every plugin load — no persistent secret.
- Discovery file lives inside the vault directory so its permissions inherit the vault's.
- No CORS, no cookies, no write endpoints.

## Troubleshooting

**`active_note` returns "plugin unavailable"**

Check in order:

1. Is Obsidian running? The plugin only answers while Obsidian is open.
2. Is the plugin enabled? Obsidian → Settings → Community plugins → verify `obsidian-brain companion` shows a green toggle.
3. Is it installed against the same vault your MCP client has `VAULT_PATH` pointing at? The discovery file is vault-scoped.
4. Look for `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json`. If missing, reload the plugin.
5. `curl -H "Authorization: Bearer $(jq -r .token …/discovery.json)" http://127.0.0.1:$(jq -r .port …/discovery.json)/status` — should return `{ok: true, ...}`. If it doesn't, the port may be blocked by something else; change it under Settings → obsidian-brain companion.

**Port conflict**

Default `27125` avoids the `27123`/`27124` owned by the Local REST API plugin. If something else is grabbing 27125 on your machine, change the port under Settings → obsidian-brain companion. After changing, disable and re-enable the plugin so the HTTP server rebinds.

**Rotated token after plugin restart**

Handled automatically. The server re-reads the discovery file on 401 and retries once.
