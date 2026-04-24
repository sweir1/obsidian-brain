---
title: Roadmap
description: Shipped releases, what's next, and what we've deliberately scoped out.
---

# Roadmap

## Recently shipped

<!-- GENERATED:recent-releases -->
{{ recent_releases(5) }}
<!-- /GENERATED:recent-releases -->

## Planned / In progress

> **Note on version numbering.** v1.7.0 shipped on 2026-04-24 as a different bundle than this page originally planned — it became the fault-tolerant-embeddings / expanded-presets / BYOM CLI / `index_status` / macOS installer release (see CHANGELOG). The block-ref editing / FTS5 frontmatter / topic-aware PageRank work below has therefore been renumbered to v1.8.0.

### v1.8.0 — block-ref editing + FTS5 frontmatter + topic-aware PageRank (~1-2 weeks)

Pairs with plugin v1.8.0.

- **`edit_note(mode: 'patch_block', block_id: '^abc123')`.** Parse `^[a-zA-Z0-9-]+$` at line end into a new `block_refs(id, node_id, start_line, end_line)` table; boundary is text from ID back to previous blank line or previous block ID. Meaningful Obsidian-power-user gap (lstpsche ships it, we don't). Adds one tool — count becomes 19.
- **FTS5 frontmatter fielding.** Tokenize frontmatter alongside title + body as a fielded index, moderate 2× boost. Complements v1.4.0's stemming + column-weighted BM25.
- **`find_influential_notes_about(topic)`.** The tool only obsidian-brain can ship because only it co-locates both signals: semantic neighborhood → induced subgraph → PageRank on the subgraph. Replaces the noisy full-vault PageRank for topic-aware "what are the hubs here". One new tool — count becomes 20.

### v1.9.0 — graph analytics credibility writeup (~1 week)

Pairs with plugin v1.9.0 (alignment, no plugin code changes).

- **Evaluation on a real vault.** Publish top-10 PageRank results on the author's actual vault, manual hit-rate assessment, write up the methodology. Per the competitive-analysis critique: an honest 60% hit rate is more credible than silence.
- Blog post + README "how well does this work" section.
- No feature code — the work is the eval + writeup.

### v2.0 — daemon mode + ecosystem reach

Revisit when user demand (resource cost, install friction) actually surfaces. None of the below is committed or dated.

- **Multi-client daemon mode.** One long-running daemon + per-client stdio-proxy shims. Shared embedder + watcher + SQLite. Saves ~200 MB RAM per extra MCP client. Needs: daemon lifecycle (auto-start, health, restart), Unix socket transport (Windows: named pipe), graceful upgrade, per-client auth. Worth it only when running 3+ simultaneous MCP clients is common.
- **Community plugin registry submission.** PR `obsidian-brain-plugin` to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) for one-click install from Obsidian's in-app Community Plugins browser (no BRAT required). Wait until the plugin's endpoint surface has stabilised (post-v1.6.0 at earliest); registry review is 1–2 weeks and re-submitting after every API change is friction.
- **Dynamic Templater-style tool registration.** If the companion plugin is installed + Templater is enabled, scan the user's templates and register each as a typed MCP tool (parsing `tp.user.askString("X")` prompts into Zod schemas). Lets "Claude, make me a meeting note" become `meeting_notes({title, attendees, date})` with validation. High ceiling, niche audience.
- **Optional git integration** for write auditing. If the vault is a git repo, each agent-initiated edit becomes a commit with attribution (`agent: claude, tool: edit_note, note: X`). Auditable + recoverable. Opt-in config flag so non-git users are unaffected.

### Explicitly NOT planned

Stances worth naming so expectations stay calibrated:

- **Cloud embeddings** (OpenAI, Voyage, Cohere). Deliberate local-only stance — zero egress, works offline, nothing leaves the machine. The v1.4.0 `Embedder` interface is forkable if anyone wants a cloud variant, but it won't be a first-party config knob.
- **DQL execution without Obsidian running.** Reimplementing Dataview's query engine + metadata cache outside Obsidian is months of work for no meaningful gain over the companion-plugin approach.
- **Full Bases feature parity** — rendered card / calendar / map views. MCP returns data; rendering is the client's job.
- **DataviewJS / JS-block execution.** Arbitrary JS eval against the vault is a security hole; skip permanently.
- **Plugin writes from the server** (move Obsidian's cursor, open a file in the UI, inject text into the editor). The companion plugin is read-only by design. If we ever want this, it's a separately-scoped feature with its own threat model and opt-in.
- **Rewrite in Rust.** Node + sqlite-vec + transformers.js covers the performance envelope. A Rust rewrite would cost months for no user-visible win.
- **Collapse to 5 hub-tools (aaronsb-style).** Good pattern for single-surface operations; wrong for a tool set with distinct graph-analytics + writes + search semantics. We take the `next_actions` hint pattern (v1.5.0), not the tool-count philosophy.

## Ideas

New ideas go here. To add one from the command line: `npm run idea -- "your idea text"`.

<!-- IDEAS:start -->
- 2026-04-23 · Cross-vault search across multiple VAULT_PATHs
- 2026-04-23 · Auto-tag suggestions from embedding clusters
- 2026-04-23 · Periodic "what have I been working on?" digest tool using recent edit timestamps
<!-- IDEAS:end -->

## Versioning policy

Plugin and server ship aligned at **major.minor** — when server goes `X.Y.0`, plugin goes `X.Y.0` the same day (even if the plugin has no code changes, as a "version alignment" release with a CHANGELOG note). Patch versions may drift. The `capabilities[]` array in `discovery.json` remains the actual compatibility handshake; version numbers are a signal to users that "plugin 1.4.x works with server 1.4.x". The plugin jumps `0.2.1 → 1.4.0` in v1.4.0 to establish the alignment baseline.
