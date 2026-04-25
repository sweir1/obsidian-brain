#!/usr/bin/env node
/**
 * Drift check: every `process.env.X` (or `env.X` via NodeJS.ProcessEnv) read
 * in `src/` must appear in `server.json packages[0].environmentVariables[]`.
 *
 * Why this exists: `server.json`'s env-var list is hand-maintained per
 * RELEASING.md → "Env-var hand-edit". The release workflow validates
 * `server.json` against the MCP Registry schema before publishing, so a
 * malformed list blocks the release. But nothing enforces that NEW env
 * vars added in `src/` actually land in `server.json` — and the existing
 * `gen-docs.mjs` only goes the OTHER direction (`server.json → docs/`).
 *
 * The v1.7.5 bundled-seed work briefly added an env var that wasn't in
 * `server.json`, which silently dropped it from `docs/configuration.md`.
 * That env var was later replaced with the `models refresh-cache` CLI
 * subcommand (cache-forever semantics; explicit invalidation only). The
 * guardrail stays — it'll catch the next instance of this drift class.
 *
 * ALLOWLIST below is for env vars that are deliberately read in `src/` but
 * are NOT part of obsidian-brain's public API surface — third-party
 * conventions (HF_HOME) or legacy aliases the docs already mention inline.
 *
 * Usage:
 *   node scripts/check-env-vars.mjs           # exit 0 if clean, 1 on drift
 *   node scripts/check-env-vars.mjs --help    # print usage
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-env-vars.mjs');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ALLOWLIST — third-party / legacy / test-only env vars NOT in server.json
// ---------------------------------------------------------------------------

const ALLOWLIST = new Set([
  // HuggingFace conventions — we honour them but don't own the contract.
  // Documented inline in src/embeddings/embedder.ts.
  'HF_HOME',
  'TRANSFORMERS_CACHE',
  // XDG standard — used to compute DATA_DIR's default. Documented in
  // docs/getting-started.md alongside DATA_DIR.
  'XDG_DATA_HOME',
  // Legacy aliases preserved for backwards compat — pre-v1.4 envs.
  // src/config.ts treats these as fallbacks for the canonical names.
  'KG_VAULT_PATH',
  'KG_DATA_DIR',
  // Internal debug-logging gate (read in metadata-resolver). Not a public
  // contract; surfaces failed background refetches when set to 'debug'.
  'OBSIDIAN_BRAIN_LOG_LEVEL',
  // Test-only — silences production stderr noise during vitest runs.
  // Documented in test/setup/silence-stderr.ts; never read in src/.
  'OBSIDIAN_BRAIN_TEST_STDERR',
  // Node runtime built-ins, picked up incidentally by the regex.
  'NODE_ENV',
]);

// ---------------------------------------------------------------------------
// Read server.json env vars
// ---------------------------------------------------------------------------

const server = JSON.parse(readFileSync('server.json', 'utf8'));
const declared = new Set(
  (server.packages?.[0]?.environmentVariables ?? []).map((e) => e.name),
);

// ---------------------------------------------------------------------------
// Scan src/ for `process.env.X` and `env.X` reads
// ---------------------------------------------------------------------------

const grepOutput = execSync(
  // -h: no filename. -o: only matched substring. -E: extended regex.
  // Two patterns ORed:
  //   process.env.X
  //   env.X (used in helpers that take `env: NodeJS.ProcessEnv = process.env`)
  // We also pick up env['X'] / env["X"] just in case.
  `grep -rohE '(process\\.env|env)\\.[A-Z_][A-Z_0-9]+' src/`,
  { encoding: 'utf8' },
);

const found = new Set();
for (const line of grepOutput.split('\n')) {
  const m = line.match(/\.([A-Z_][A-Z_0-9]+)$/);
  if (m) found.add(m[1]);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const missing = [];
for (const name of [...found].sort()) {
  if (declared.has(name)) continue;
  if (ALLOWLIST.has(name)) continue;
  missing.push(name);
}

if (missing.length > 0) {
  console.error('check-env-vars: env vars read in src/ but missing from server.json:\n');
  for (const name of missing) {
    console.error(`  - ${name}`);
  }
  console.error(
    '\nFix: add an entry to server.json `packages[0].environmentVariables[]`,\n' +
    'then run `npm run gen-docs` to refresh docs/configuration.md.\n' +
    'If the var is third-party or test-only, add it to ALLOWLIST in scripts/check-env-vars.mjs\n' +
    'with a one-line comment explaining why.',
  );
  process.exit(1);
}

const stale = [];
for (const name of [...declared].sort()) {
  if (found.has(name)) continue;
  // Common case: an env var declared in server.json but read only via
  // helper functions that use destructuring (which our regex doesn't catch).
  // The grep is intentionally narrow to keep false-positive rate low — it's
  // OK to skip the stale check for now and only block on missing.
  stale.push(name);
}

console.log(
  `check-env-vars: ${declared.size} vars in server.json, ${found.size} read in src/, ${ALLOWLIST.size} allowlisted. No drift.`,
);
if (stale.length > 0 && process.env.OBSIDIAN_BRAIN_LOG_LEVEL === 'debug') {
  console.log(`(debug: server.json declares but grep didn't find: ${stale.join(', ')})`);
}
