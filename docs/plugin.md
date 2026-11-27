---
title: Companion plugin
description: Optional Obsidian plugin that unlocks active_note, dataview_query, and base_query by exposing live runtime state over a localhost HTTP endpoint.
---

# Companion Obsidian plugin

`obsidian-brain` works against your vault's files on disk. Three kinds of data, however, **only exist inside a running Obsidian process**: Dataview DQL query results, Obsidian Bases view rows, and active-editor state (what note is open, cursor position). These require a small companion plugin that runs inside Obsidian.

Repo: [`sweir1/obsidian-brain-plugin`](https://github.com/sweir1/obsidian-brain-plugin).

## What it does

On plugin load:

1. Binds an HTTP server to `127.0.0.1` on a configurable port (default `27125`).
2. Generates a random bearer token (regenerated every startup, never persisted).
3. Writes `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json` with `{port, token, pid, pluginVersion, startedAt, capabilities}`.

`obsidian-brain server` reads the discovery file based on `VAULT_PATH`, authenticates every request with the token, and re-reads discovery on any 401 or ECONNREFUSED (so a plugin restart that rotated the token doesn't wedge the MCP tools).

**Capability gating**: the plugin writes a `capabilities: string[]` array naming the features it exposes (e.g. `["status", "active", "dataview", "base"]`). The server reads this to fail fast on a missing capability — calling `dataview_query` against a plugin that doesn't advertise `dataview` returns a clean "this version of the plugin doesn't expose the route" error *before* the HTTP call, instead of an opaque 404 from the route lookup.

## Install

### Via BRAT (while in pre-release)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In Obsidian: `BRAT: Add a beta plugin for testing` → enter `sweir1/obsidian-brain-plugin`.
3. Enable `obsidian-brain companion` under Settings → Community plugins.

### Manual

Download `main.js` + `manifest.json` from the [latest release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest), drop them into `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`, reload Obsidian, enable under Community plugins.

## Version compatibility

**Rule of thumb:** install the **same major.minor** on both sides — server `v1.7.x` pairs with plugin `v1.7.x`. Patch-version drift (e.g. server `1.7.5` + plugin `1.7.0`) is fine. Other combinations often work thanks to capability gating — the plugin advertises its supported routes in `discovery.json` and the server fails loudly with a clean "this capability isn't available" error if a required capability is missing — but aren't explicitly tested and aren't guaranteed. If you mix and something breaks, upgrade the lagging side.

## Which tools require it

| Tool | Needs plugin? | Notes |
|---|---|---|
| `active_note` | yes | Returns the path + cursor + selection of the note currently open in Obsidian. |
| `dataview_query` | yes | Runs a DQL query via the Dataview plugin. See [Dataview](#dataview) below. |
| `base_query` | yes (Obsidian ≥ 1.10.0, Bases core plugin enabled) | Evaluates an Obsidian Bases `.base` file. See [Bases](#bases) below. |

Every other tool (`search`, `read_note`, `list_notes`, `find_connections`, `find_path_between`, `detect_themes`, `rank_notes`, `create_note`, `edit_note`, `apply_edit_preview`, `link_notes`, `move_note`, `delete_note`, `reindex`) works standalone with or without the plugin.

When the plugin is absent or unreachable, the plugin-dependent tools return an error containing the install instructions verbatim — the rest of the server keeps working normally.

## Security

- Localhost-only (`127.0.0.1`). Never binds to a LAN interface.
- Bearer token required on every request. Random 32-byte hex, regenerated on every plugin load — no persistent secret.
- Discovery file lives inside the vault directory so its permissions inherit the vault's.
- No CORS, no cookies, no write endpoints.

## Dataview

> [!IMPORTANT]
> **Dataview is a separate third-party community plugin, not built by us and not shipped with Obsidian.** You install it from Obsidian → Settings → Community plugins → Browse → search "Dataview" (by blacksmithgu) → Install → Enable, then reload Obsidian once so its API registers on `app.plugins.plugins.dataview.api`. `dataview_query` returns 424 with a clear `not_installed` / `not_enabled` / `api_not_ready` message until that's done. Full DQL syntax reference: [blacksmithgu.github.io/obsidian-dataview](https://blacksmithgu.github.io/obsidian-dataview/). Step-by-step walkthrough in [Installing Dataview](#installing-dataview) below.

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

- Companion plugin advertising the `dataview` capability (current releases all do).
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
- Capability error *before* HTTP call → plugin is an older release that doesn't expose `dataview` via the `/discovery` handshake. Upgrade to a current release matching your server's major.minor.

### DQL reference

See the upstream [DQL query structure](https://blacksmithgu.github.io/obsidian-dataview/queries/structure/) and [query types](https://blacksmithgu.github.io/obsidian-dataview/queries/query-types/) docs.

## Bases

### What Bases is

Bases is a **core** Obsidian feature (not a community plugin). A `.base` file is a YAML document with optional global `filters:` and `formulas:`, and a `views:` list — each view has a `type` (table, cards, list, kanban, map, …), a `name`, its own `filters:`, the columns to show (`order:`), and optionally `sort:`, `limit:` and `groupBy:`. Inside Obsidian, Bases renders each view as a table, cards or board you can navigate in the UI.

`base_query` evaluates a view headlessly and returns the rows as JSON, so an MCP client can ask "give me all books I'm currently reading with rating ≥ 4" without a human opening the base.

### How it's evaluated

Obsidian exposes Bases to plugins only through view hooks (`Plugin.registerBasesView()`, `BasesView`, `BasesQueryResult`); there is no public `runQuery(config)` that returns rows. So the companion plugin reads the `.base` YAML itself (with Obsidian's bundled `parseYaml`) and evaluates it against the vault's files and Obsidian's metadata cache, following the [Bases syntax](https://help.obsidian.md/bases/syntax):

- **Rows:** every file in the vault, as in Obsidian — notes and attachments.
- **Filters:** global and view `filters:`, combined with AND. `and` / `or` / `not` groups nest; `not` excludes a file if any listed condition holds.
- **Expressions:** `note.x`, `note["x"]` or bare `x`; `file.*` properties (`name` with extension, `basename`, `path`, `folder`, `ext`, `size`, `ctime`, `mtime`, `tags`, `links`, …); `formula.x`; arithmetic, including date ± duration (`now() - "1 week"`); comparisons; `&&` `||` `!`.
- **Functions:** `if`, `now`, `today`, `date`, `duration`, `number`, `list`, `min`, `max`; `file.hasTag` (nested tags included), `file.inFolder`, `file.hasLink`, `file.hasProperty`; and the common string, number, list, date and object methods. The full list is in the [companion plugin README](https://github.com/sweir1/obsidian-brain-plugin#how-a-base-is-evaluated).
- **Formulas** are computed per row and can build on each other.
- **Views:** `order`, `sort` (`{property, direction}`), `groupBy` with `groupOrder`, and `limit`. Every view type selects rows the same way.

**Not evaluated** — these return `400 unsupported_construct` naming the construct, never wrong rows: `this` (it depends on where Obsidian displays the base), regular expressions, list `filter` / `map` / `reduce`, and display-only functions (`link`, `image`, `icon`, `html`, …). A **column** whose formula can't be computed comes back as `null` with a note in `warnings`, so one display formula doesn't fail the whole query.

Display-only keys (`properties:`, `summaries:`, `columnSize:`) are ignored. Files in the format earlier companion versions used (`views:` as a map, `columns:`, `frontmatter.x`) still work.

### Requirements recap

- Companion plugin advertising the `base` capability (current releases all do).
- Obsidian **≥ 1.10.0** — the handler verifies via `typeof Plugin.prototype.registerBasesView === "function"`.
- Bases core plugin **enabled** (Obsidian → Settings → Core plugins → toggle "Bases" on). The plugin reads this from Obsidian's core-plugin registry.
- Obsidian running — the evaluator reads the live metadata cache.

### Request shape

MCP input:

```json
{
  "file": "Bases/Books.base",
  "view": "Reading now",
  "timeoutMs": 30000
}
```

`view` is the view's `name:`; omit it to run the first view (older companion plugins require `view`; keep the plugin on the same major.minor as the server). Instead of a file path you can pass the YAML inline:

```json
{
  "yaml": "filters:\n  and:\n    - file.hasTag(\"book\")\nviews:\n  - type: table\n    name: Reading now\n    filters:\n      and:\n        - status == \"reading\"\n    order:\n      - file.name\n      - status\n      - rating\n"
}
```

Either `file` or `yaml` is required. When both are supplied, `file` wins.

### Response shape

```json
{
  "view": "Reading now",
  "rows": [
    {"file": {"name": "Dune.md", "basename": "Dune", "path": "Books/Dune.md"}, "file.name": "Dune.md", "status": "reading", "rating": 5}
  ],
  "total": 42,
  "executedAt": "2026-11-27T10:30:00.000Z"
}
```

- `view` is the name of the view that ran.
- `rows` — one object per matching file. `file` always has `{name, basename, path}` (`name` includes the extension, as in Obsidian). The other keys are the view's `order:` columns: note properties without the `note.` prefix (`status`), everything else as written (`file.mtime`, `formula.ppu`). Values are JSON; dates are ISO strings.
- `total` is the count before `limit`. If the view sets `limit: 10` and 42 match, `total` is 42 and `rows.length` is 10.
- Grouped views (`groupBy:`) also return `groupBy` and `groups: [{value, count}]`.
- `warnings` (optional) lists non-fatal problems, such as a column formula that couldn't be computed.
- `executedAt` is when the plugin finished evaluating.

### Timeout caveat

`timeoutMs` (default 30000) bounds the HTTP wait. The plugin evaluator itself has **no cancellation API** — it walks every file in the vault to build entries, then runs the filters. If the timeout fires, the evaluator keeps running inside Obsidian until it finishes. Mitigations:

1. Prefer `limit: N` inside the view for open-ended queries over large vaults.
2. The plugin **serialises** `/base` requests — a second expensive evaluation can't stack behind a stuck first one. Second call queues until the first finishes.

### Errors

- `424 bases_not_enabled` → Obsidian's Bases core plugin is off. Toggle it on: Settings → Core plugins → Bases.
- `424 unsupported_obsidian_version` → Obsidian < 1.10.0. Upgrade Obsidian.
- `400 bad_request` → Neither `file` nor `yaml` supplied, or `view` isn't a string.
- `400 base_file_read_failed` → `file` path didn't resolve against `app.vault.adapter.read`.
- `400 unsupported_construct` → Filter/sort/column referenced an expression the current subset doesn't cover. Message names the fragment verbatim.
- `400 base_eval_error` → YAML or structural problem (no `views:`, unknown view name — the message lists the available ones — malformed `sort:`, circular formulas).
- Capability error *before* HTTP call → plugin doesn't advertise `base` in its discovery file. Upgrade the companion plugin to a current release matching your server's major.minor.

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

**`dataview_query` requires a companion plugin that advertises the `dataview` capability**

Error returned *before* the HTTP call because the server sees the plugin doesn't advertise the `dataview` capability in its discovery file. Upgrade the plugin:

- BRAT: `Check for updates` → install the latest release.
- Manual: download `main.js` + `manifest.json` from the [plugin's latest release](https://github.com/sweir1/obsidian-brain-plugin/releases/latest), overwrite the existing files in `{VAULT}/.obsidian/plugins/obsidian-brain-companion/`. Disable + re-enable the plugin in Settings → Community plugins.

**`dataview_query` timed out**

The HTTP wait exceeded `timeoutMs` (default 30000). The Dataview query itself keeps running inside Obsidian until it finishes — Dataview has no cancellation API. Either add `LIMIT N` to your DQL, or raise `timeoutMs` if the query is genuinely expensive. Concurrent requests queue server-side (one in-flight at a time), so a second call won't make things worse.
