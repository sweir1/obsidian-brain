# Roadmap

What's shipped, what's next, what we've deliberately scoped out. Revised on each release.

*Last updated: 2026-04-22 (v1.3.1 + plugin v0.2.1)*

---

## Shipped

| Release | Scope | Paired plugin |
|---|---|---|
| v1.0.0 | Core: semantic search + knowledge graph + vault editing over stdio MCP | — |
| v1.1.x | Live file watcher (chokidar) replaces scheduled reindex; offline-catchup on boot | — |
| v1.2.0 | `active_note` via companion plugin (first plugin-dependent tool) | 0.1.0 |
| v1.2.1 | Defensive hardening — per-tool timeout, SQLite WAL `busy_timeout = 5000`, embedder request serialisation | 0.1.0 |
| v1.2.2 | Theme-cache correctness, `patch_heading` `scope: 'body'`, `valueJson` for stringifying harnesses | 0.1.0 |
| v1.3.0 | `dataview_query` + capability gating via plugin discovery | 0.2.0 |
| v1.3.1 | Discriminated Dataview 424 responses (not-installed / not-enabled / api-not-ready) + doc-currency fixes | 0.2.1 |

---

## Next up

### v1.4.0 — `base_query` (Obsidian Bases)

**Status**: planned, not started. Pairs with **plugin v0.3.0**.

**What**: a `base_query` MCP tool that evaluates an Obsidian `.base` file against the vault's metadata cache and returns the selected view's rows.

**Path decision on kickoff**: re-check Obsidian's Bases plugin API for a read-access surface (`getBaseResults` or equivalent). As of 2026-04-22 there's still no such API — the v1.10 Bases plugin API exposes only `registerBasesView()` for plugins contributing custom view renderers. If a read-access API lands between now and v1.4.0 start → pivot to **Path A** (~50 LoC passthrough). Otherwise → **Path B**: parse and evaluate the `.base` YAML ourselves in the companion plugin.

**Supported subset (Path B, minimal)**:
- YAML tree ops: `filters.{and, or, not}`, nested
- Comparisons: `==, !=, >, >=, <, <=`
- Leaf-string boolean: `&&, ||, !`
- File properties: `file.{name, path, folder, ext, size, mtime, ctime, tags}`
- File methods: `file.hasTag("x")`, `file.inFolder("x")`
- Frontmatter access: `frontmatter.X`, bare `X`, nested dot access
- View-level `filters:` conjoined with top-level `filters:`

**Explicitly not supported in v1.4.0** (clean "unsupported construct" errors surfacing the offending fragment):
- Arithmetic (`+, -, *, /, %`), date arithmetic with durations (`date + "1M"`)
- Method calls (`.toFixed, .toString, .format, .contains, .asLink, .date`)
- Function calls (`today()`, `now()`, `date()`, `list()`, `link()`, `icon()`)
- Regex literals (`/pattern/flags.matches(x)`)
- `formulas:` block, `summaries:` block
- `this` context references

**v1.4.x path** if users hit the unsupported wall:
- v1.4.1: arithmetic + date arithmetic + method calls
- v1.4.2: formulas
- v1.4.3: summaries

**Effort**: ~10–15 h focused (Path B) or ~1–2 h (Path A if API lands). **Risk**: medium — new recursive-descent expression parser with semantic-drift risk vs. Obsidian's own evaluator. Mitigated by fixture-driven tests against a real `.base` in a tiny vault.

### v1.5.0 — deferred UX bundle

**Status**: planned, not started. Server-only (no plugin changes).

Four small, independent fixes from two field-test reports that were deferred out of earlier correctness-focus releases:

- **L1 — `move_note` inbound link fix-up** (~100 LoC + fixtures). Scan `[[old]]`, `[[old|display]]`, `![[old]]` across the vault; rewrite to the new path on move. Reuses `src/vault/wiki-links.ts`.
- **L3 — `patch_heading` multi-match disambiguation** (~30 LoC). Currently first-match-silently wins. Change: multiple matches → error listing occurrences + line numbers; accept `headingIndex?: number` to pick one.
- **L4 — `read_note` truncation signal** (~15 LoC). Add `truncated: boolean` to the response when `maxContentLength` cut the body.
- **L5 — `includeStubs` on `detect_themes` + `rank_notes`** (~20 LoC). Matches the v1.2.2 addition to `list_notes`. Default `true` for backcompat.

**Effort**: ~3–5 h focused for the whole bundle. **Risk**: low — isolated fixes, no architectural changes.

**Intentionally deferred** from v1.5.0 to their own future milestones:
- **L2 — `dryRun?: boolean`** on `edit_note`, `move_note`, `delete_note`, `link_notes`. A proper feature deserving its own design pass (what's the diff format? returned inline or via a separate tool?).
- **L6 — bulk `edit_note`** (tuple array, atomic rollback). Heavy and high-value — warrants its own milestone.

### Plugin v0.3.0 — Bases proxy

Pairs with server v1.4.0. Adds `POST /base` route + YAML/expression evaluator modules. Appends `base` to the advertised `capabilities` list so the server gates `base_query` on plugin version (same pattern as v0.2.0's `dataview`). No change to existing routes.

**Effort**: subsumed into v1.4.0's 10–15 h estimate.

---

## Aspirational (v2.0 territory)

Neither committed nor dated — revisit when user demand actually surfaces.

- **Multi-client daemon mode**. One long-running daemon; stdio-proxy shims per MCP client. Shared embedder, shared watcher, shared SQLite. Saves ~200 MB RAM per extra client. Needs: daemon lifecycle (auto-start, health checks, restart on crash), Unix socket transport (Windows: named pipe), graceful upgrade, per-client auth. Worth it only if users complain about the resource overhead of running one server per MCP client.
- **Community plugin registry submission**. PR `obsidian-brain-companion` to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) so the plugin gets one-click install from inside Obsidian's Community Plugins browser (instead of requiring BRAT). Wait until v1.4.0 Bases ships and the plugin's endpoint surface stabilises — registry review is 1–2 weeks, and re-submitting after every API change is friction. Pairs with plugin v1.0.0.

---

## Explicitly NOT planned

Stances worth naming so expectations stay calibrated:

- **Cloud embeddings** (OpenAI, Voyage, Cohere). Deliberate local-only stance — zero egress, works offline, nothing leaves the machine. The `Embedder` class in `src/embeddings/embedder.ts` is forkable if anyone wants a cloud variant, but it won't be a first-party config knob.
- **DQL execution without Obsidian running**. Reimplementing Dataview's query engine + metadata cache outside Obsidian is months of work for no meaningful gain over the companion-plugin approach.
- **Full Bases feature parity** — rendered card / calendar / map views. MCP returns data; rendering is the client's job.
- **DataviewJS / JS block execution**. Arbitrary JS eval against the vault is a security hole; skip permanently.
- **Plugin writes from the server** (move Obsidian's cursor, open a file in the UI, inject text into the editor). The companion plugin is read-only by design. If we ever want this, it's a separately-scoped feature with its own threat model and opt-in.

---

## How this list updates

- Every release bumps the "shipped" table.
- Anything in the "next up" section that ships moves up into "shipped"; anything learned during execution (scope revisions, newly-discovered risk) edits the entry in place.
- Field-test feedback and user issues can add entries; nothing gets added speculatively.
- Items in "NOT planned" require a documented reason to move out of that bucket.

For bug fixes and maintenance releases that don't change the roadmap shape, just the "shipped" table gets a row.
