---
title: Build from source
description: You only need this if you're modifying obsidian-brain. Normal users install from npm via Quick start.
---

# Build from source

You only need this path if you want to modify the server. Normal users install from npm via [Quick start](getting-started.md).

## Setup

```bash
git clone https://github.com/sweir1/obsidian-brain.git
cd obsidian-brain
npm install
npm run build
VAULT_PATH="$HOME/path/to/vault" node dist/cli/index.js server
```

Point your MCP client at `/absolute/path/to/obsidian-brain/dist/cli/index.js` with arg `server` if you want to test a local build.

## Repo layout

Key directories under `src/`:

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

## Common commands

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm test` | Run vitest unit tests. |
| `npm run smoke` | End-to-end MCP smoke test against a throwaway temp vault. |
| `npm run dev` | Run the server directly via `tsx` (no build step — handy for iteration). |
| `npm run preflight` | Mirror the CI gate locally (gen-docs check, build, test+coverage, smoke, docs:build, codespell). |
| `python3 scripts/build-seed.py` | Regenerate `data/seed-models.json` from MTEB's Python registry (zero HF API calls). Requires `pip install 'mteb>=2.12,<3'` once. Auto-runs at every release in `release.yml`; rarely needs running locally. Completes in ~5 seconds. |
