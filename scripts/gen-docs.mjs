#!/usr/bin/env node
/**
 * Regenerate the env-var table in docs/configuration.md from server.json.
 *
 * Usage:
 *   node scripts/gen-docs.mjs           # write updated table
 *   node scripts/gen-docs.mjs --check   # diff; exit 1 on drift
 *   node scripts/gen-docs.mjs --help    # print usage
 *
 * Reads `packages[0].environmentVariables[]` from server.json and renders a
 * markdown table between the `<!-- GENERATED:env-vars -->` and
 * `<!-- /GENERATED:env-vars -->` markers in docs/configuration.md.
 * Everything outside the markers is preserved byte-for-byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MARKER_START = '<!-- GENERATED:env-vars -->';
const MARKER_END   = '<!-- /GENERATED:env-vars -->';

function usage() {
  console.log(`Usage: node scripts/gen-docs.mjs [--check] [--help|-h]

  (no flags)   Regenerate the env-var table in docs/configuration.md.
  --check      Diff current file against would-be output; exit 1 on drift.
  --help/-h    Print this message.
`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}
const CHECK_MODE = args.includes('--check');

// ── Paths ────────────────────────────────────────────────────────────────────
const root = new URL('..', import.meta.url);
const serverJsonPath   = new URL('server.json',              root);
const configMdPath     = new URL('docs/configuration.md',   root);

// ── Read inputs ──────────────────────────────────────────────────────────────
let serverJson;
try {
  serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));
} catch (e) {
  console.error(`gen-docs: failed to read server.json — ${e.message}`);
  process.exit(1);
}

const envVars = serverJson?.packages?.[0]?.environmentVariables;
if (!Array.isArray(envVars)) {
  console.error('gen-docs: server.json packages[0].environmentVariables is missing or not an array.');
  process.exit(1);
}

let configMd;
try {
  configMd = readFileSync(configMdPath, 'utf8');
} catch (e) {
  console.error(`gen-docs: failed to read docs/configuration.md — ${e.message}`);
  process.exit(1);
}

// ── Locate markers ───────────────────────────────────────────────────────────
const startIdx = configMd.indexOf(MARKER_START);
const endIdx   = configMd.indexOf(MARKER_END);

if (startIdx === -1 || endIdx === -1) {
  console.error(
    `gen-docs: markers not found in docs/configuration.md.\n` +
    `Please add the following lines around the env-var table:\n` +
    `  ${MARKER_START}\n` +
    `  ${MARKER_END}`
  );
  process.exit(1);
}

if (endIdx < startIdx) {
  console.error('gen-docs: <!-- /GENERATED:env-vars --> appears before <!-- GENERATED:env-vars -->.');
  process.exit(1);
}

// ── Render table ─────────────────────────────────────────────────────────────
function renderTable(vars) {
  const header = `| Variable | Required | Default | Description |`;
  const sep    = `|---|---|---|---|`;
  const rows = vars.map(v => {
    const name     = `\`${v.name}\``;
    const required = v.isRequired ? 'yes' : 'no';
    const def      = v.default != null ? String(v.default) : '—';
    let desc       = v.description ?? '';
    if (Array.isArray(v.choices) && v.choices.length > 0) {
      desc += ` *Choices: ${v.choices.join(', ')}*`;
    }
    return `| ${name} | ${required} | ${def} | ${desc} |`;
  });
  return [header, sep, ...rows].join('\n');
}

const newTable = renderTable(envVars);

// ── Splice into file ──────────────────────────────────────────────────────────
// Content between markers (excluding the marker lines themselves)
const afterStartMarker = startIdx + MARKER_START.length;
const currentInner = configMd.slice(afterStartMarker, endIdx);

// We wrap table with a leading + trailing newline inside the markers
const newInner = `\n${newTable}\n`;

if (CHECK_MODE) {
  if (currentInner === newInner) {
    console.log('gen-docs --check: docs/configuration.md is up to date.');
    process.exit(0);
  }
  // Print a simple diff
  console.error('gen-docs --check: drift detected in docs/configuration.md env-var table.\n');
  console.error('--- current (between markers) ---');
  console.error(currentInner);
  console.error('--- expected (from server.json) ---');
  console.error(newInner);
  process.exit(1);
}

const newConfigMd =
  configMd.slice(0, afterStartMarker) +
  newInner +
  configMd.slice(endIdx);

writeFileSync(configMdPath, newConfigMd);
console.log(`gen-docs: docs/configuration.md updated (${envVars.length} env vars).`);
