---
title: obsidian-brain
description: Local MCP server: semantic search, knowledge graph, and vault editing over an Obsidian vault.
---

# obsidian-brain

A local MCP server that gives Claude (and any MCP client) **semantic search**, a **live knowledge graph**, and **vault editing** over an Obsidian vault. Stdio-only, no cloud, nothing hosted.

[Get started](getting-started.md){ .md-button .md-button--primary } [Mac walkthrough (non-technical)](install-mac-nontechnical.md){ .md-button }

<div class="grid cards" markdown>

-   :material-magnify: **Find**

    ---

    Hybrid semantic + BM25 search via `search`, chunk-level embeddings, Reciprocal Rank Fusion ranking.

    [Tools reference →](tools.md)

-   :material-graph: **Map**

    ---

    PageRank, Louvain community detection, path-finding between notes — knowledge graph analytics over your vault.

    [Architecture →](architecture.md)

-   :material-pencil: **Write**

    ---

    `edit_note`, `create_note`, `move_note`, `link_notes` with dry-run previews and atomic bulk edits.

    [Tools reference →](tools.md)

</div>

Current published version: **v{{ version }}** · [Changelog](CHANGELOG.md)
