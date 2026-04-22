# Companion Obsidian plugin

`obsidian-brain` works against your vault's files on disk. Three kinds of data, however, **only exist inside a running Obsidian process**: Dataview DQL query results, Obsidian Bases view rows, and active-editor state (what note is open, cursor position). These require a small companion plugin that runs inside Obsidian.

Repo: [`sweir1/obsidian-brain-plugin`](https://github.com/sweir1/obsidian-brain-plugin).

## What it does

On plugin load:

1. Binds an HTTP server to `127.0.0.1` on a configurable port (default `27125`).
2. Generates a random bearer token (regenerated every startup, never persisted).
3. Writes `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt, capabilities}`.

`obsidian-brain server` reads the discovery file based on `VAULT_PATH`, authenticates every request with the token, and re-reads discovery on any 401 or ECONNREFUSED (so a plugin restart that rotated the token doesn't wedge the MCP tools).

**Capability gating** *(plugin v0.2.0+)*: the plugin writes a `capabilities: string[]` array naming the features it exposes (e.g. `["status", "active", "dataview"]`). The server uses this to fail fast on version mismatch — calling `dataview_query` against a v0.1.x plugin returns a clean "upgrade to v0.2.0" error *before* the HTTP call, instead of an opaque 404 from the route lookup. Plugins without the field are treated as `["status", "active"]` for backward compatibility.

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
| `dataview_query` (v1.3.0+) | yes (plugin ≥ 0.2.0) | Runs a DQL query via the Dataview plugin. See [Dataview](#dataview) below. |
| `base_query` (planned, v1.4.0) | yes | Evaluates an Obsidian Bases `.base` file. |

Every other tool (`search`, `read_note`, `list_notes`, `find_connections`, `find_path_between`, `detect_themes`, `rank_notes`, `create_note`, `edit_note`, `link_notes`, `move_note`, `delete_note`, `reindex`) works standalone with or without the plugin.

When the plugin is absent or unreachable, the plugin-dependent tools return an error containing the install instructions verbatim — the rest of the server keeps working normally.

## Security

- Localhost-only (`127.0.0.1`). Never binds to a LAN interface.
- Bearer token required on every request. Random 32-byte hex, regenerated on every plugin load — no persistent secret.
- Discovery file lives inside the vault directory so its permissions inherit the vault's.
- No CORS, no cookies, no write endpoints.

## Dataview

### What "the Dataview community plugin" actually is

Three pieces of software are involved in a single `dataview_query` call, with overlapping names. Two are ours; one isn't:

| # | Name | Who wrote it | Where it runs |
|---|---|---|---|
| 1 | **`obsidian-brain`** | us | The MCP server (Node package). Spawned by your MCP client. |
| 2 | **`obsidian-brain-companion`** | us | Obsidian plugin. Exposes the `/dataview` HTTP route. |
| 3 | **Dataview** (`obsidian-dataview`) | [blacksmithgu](https://github.com/blacksmithgu/obsidian-dataview) | Third-party Obsidian community plugin with ~4M+ installs ([obsidian-releases community-plugin-stats.json](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json): 4,008,313 as of April 2025). Implements DQL + an in-memory vault index. |

**Version landscape** (as of 2026-04-22): end users installing via Obsidian's Community Plugin browser get **0.5.70** (GitHub release, 2025-04-07 — this is what runs in their vault). Developers who `npm install -D obsidian-dataview` for types get **0.5.68** (2025-03-15). User-facing runtime is unaffected either way because `getAPI(app)` returns whatever Dataview the user actually has installed. (Upstream's own "Develop Against Dataview" docs page still cites `0.5.64` — both channels are ahead of the docs.)

We do not reimplement DQL. The chain is:

```
MCP client → obsidian-brain (stdio JSON-RPC)
            → companion plugin (HTTP POST /dataview on 127.0.0.1)
              → Dataview API (in-process JS call: api.query(source, originFile?))
                → returns Result<QueryResult, string>
              ← normalizer flattens Link/DateTime/DataArray/Duration
            ← { kind, ... }
          ← normalized result
```

The companion plugin resolves Dataview via `app.plugins.plugins.dataview?.api`. That's literally what Dataview's own `getAPI(app)` sanctioned wrapper does internally ([src/index.ts L49-52](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/index.ts)):

```ts
export const getAPI = (app?: App): DataviewApi | undefined => {
  if (app) return app.plugins.plugins.dataview?.api;
  else return window["DataviewAPI"];
};
```

Both paths return the same `DataviewApi` object. We use the back-door path because it avoids making `obsidian-dataview` a runtime dependency. Authoritative upstream: Dataview's [plugin-author guide](https://blacksmithgu.github.io/obsidian-dataview/resources/develop-against-dataview/) and [plugin-api.ts source](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/api/plugin-api.ts).

### Installing Dataview

Dataview is installed in **Obsidian**, not via npm:

1. Obsidian → Settings → Community plugins → Browse.
2. Search "Dataview" (by blacksmithgu).
3. Install → Enable.
4. Reload Obsidian once. The plugin API registers on `app.plugins.plugins.dataview` at enable-time, but a fresh install sometimes needs a reload before our companion plugin can see it.

`dataview_query` requires **both** plugins enabled in the same vault. If Dataview is missing, our companion returns HTTP 424 and the MCP tool surfaces an install-prompt message verbatim.

### The `index-ready` caveat

Dataview builds its index asynchronously after Obsidian startup and fires `app.metadataCache.on("dataview:index-ready", ...)` when the first pass completes. Before that event fires, `api.query()` may return partial results against an incomplete index. We don't currently block on that event — in practice reindexing is fast enough that interactive use rarely notices. If `dataview_query` returns surprisingly few rows in the first few seconds of Obsidian startup, retry after the index warms. Subsequent vault changes are picked up via Dataview's own `dataview:metadata-change` events without needing to wait again.

### Requirements recap

- Companion plugin v0.2.0+ (advertises the `dataview` capability).
- The Dataview community plugin installed in the same vault and enabled.
- Obsidian running — the query is evaluated in-process.

### Request shape

MCP input:

```json
{
  "query": "TABLE file.name, rating FROM #book WHERE status = \"reading\" LIMIT 50",
  "source": "optional/origin-file.md",
  "timeoutMs": 30000
}
```

### Response shape (normalized)

The plugin flattens Dataview's runtime types — `Link`, `DateTime`, `DataArray`, `Duration` — to plain JSON before they go over the wire, so MCP clients don't need the Dataview typings to understand the output. The wire format is a discriminated union keyed by `kind`:

| kind | payload | notes |
|---|---|---|
| `table` | `{ headers: string[], rows: Value[][] }` | `Link` → path string; `DateTime` → ISO; `DataArray` → plain array |
| `list` | `{ values: Value[] }` | Same flattening per value |
| `task` | `{ items: NormalizedListItem[] }` | Includes both `SListEntry` (`task: false`) and `STask` (`task: true`); grouping trees are flattened into a flat list keyed by `path` + `line` |
| `calendar` | `{ events: [{date, link, value?}] }` | `date` is ISO; `link` is the vault-relative path |

`NormalizedListItem` fields: `task`, `text`, `path`, `line`, `tags`, `children`, plus (when `task: true`): `status`, `checked`, `completed`, `fullyCompleted`, `due`, `completion`, `scheduled`, `start`, `created`.

### Timeout caveat

Dataview's `api.query()` does **not** support cancellation. `timeoutMs` bounds how long this tool waits for the HTTP response; if it fires, the query is still running inside Obsidian to completion, burning CPU. Two mitigations:

1. Prefer `LIMIT N` in DQL for any open-ended query over a large vault.
2. The plugin serialises `/dataview` requests — a second expensive query can't stack behind a stuck first one. You'll get queued until the first finishes.

### Errors

- `424 dataview_not_installed` → Dataview community plugin isn't in the vault. Install it from Settings → Community plugins.
- `400 dql_error` → Dataview rejected the query (syntax, unknown field, etc.). The message is surfaced verbatim.
- Capability error *before* HTTP call → plugin is v0.1.x and doesn't know the `/dataview` route. Upgrade to v0.2.0.

### DQL reference

See the upstream [DQL query structure](https://blacksmithgu.github.io/obsidian-dataview/queries/structure/) and [query types](https://blacksmithgu.github.io/obsidian-dataview/queries/query-types/) docs.

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

**`dataview_query` returns "Dataview community plugin is not installed"**

424 response from the companion plugin. You need **both** plugins enabled in the vault:

1. obsidian-brain companion (this one) — exposes the `/dataview` route.
2. Dataview (blacksmithgu) — evaluates the actual DQL. Install from Settings → Community plugins → Browse → search "Dataview".

Dataview's own plugin must be enabled (not just installed). If both are enabled and you still see the error, reload Obsidian — the companion checks for Dataview via `app.plugins.plugins.dataview.api` at request time, so a freshly-enabled Dataview may need an Obsidian reload before its API is registered on the global.

**`dataview_query` requires the companion plugin v0.2.0 or later**

Error returned *before* the HTTP call because the server sees the plugin doesn't advertise the `dataview` capability in its discovery file. Upgrade the plugin:

- BRAT: `Check for updates` → install v0.2.0.
- Manual: download `main.js` + `manifest.json` from the [plugin's latest release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest) and overwrite the v0.1.x files in `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`. Disable + re-enable the plugin in Settings → Community plugins.

**`dataview_query` timed out**

The HTTP wait exceeded `timeoutMs` (default 30000). The Dataview query itself keeps running inside Obsidian until it finishes — Dataview has no cancellation API. Either add `LIMIT N` to your DQL, or raise `timeoutMs` if the query is genuinely expensive. Concurrent requests queue server-side (one in-flight at a time), so a second call won't make things worse.
