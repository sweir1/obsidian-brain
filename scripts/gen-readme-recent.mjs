#!/usr/bin/env node
/**
 * Regenerate the "Recent releases" bullet list in README.md from
 * docs/CHANGELOG.md.
 *
 * Usage:
 *   node scripts/gen-readme-recent.mjs           # write updated section
 *   node scripts/gen-readme-recent.mjs --check   # diff; exit 1 on drift
 *   node scripts/gen-readme-recent.mjs --help    # print usage
 *
 * Parses every `## v<x.y.z> [— YYYY-MM-DD] [— <title>]` header in
 * `docs/CHANGELOG.md`, takes the latest `N=5`, and renders them as
 * markdown bullets between the
 *
 *   <!-- GENERATED:recent-releases ... -->
 *   ...
 *   <!-- /GENERATED:recent-releases -->
 *
 * markers in `README.md`. Everything outside the markers is preserved
 * byte-for-byte.
 *
 * Mirrors the existing `recent_releases` mkdocs macro in `website/main.py`
 * so the README and the docs site agree on what counts as a "recent
 * release" — same regex, same precedence, same N.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const N_RECENT          = 5;
const MARKER_START_PREFIX = '<!-- GENERATED:recent-releases';   // allows trailing free-text in the marker
const MARKER_END        = '<!-- /GENERATED:recent-releases -->';

function usage() {
  console.log(`Usage: node scripts/gen-readme-recent.mjs [--check] [--help|-h]

  (no flags)   Regenerate the Recent releases section in README.md.
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
const root          = new URL('..', import.meta.url);
const changelogPath = new URL('docs/CHANGELOG.md', root);
const readmePath    = new URL('README.md', root);

// ── Read inputs ──────────────────────────────────────────────────────────────
let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf8');
} catch (e) {
  console.error(`gen-readme-recent: failed to read docs/CHANGELOG.md — ${e.message}`);
  process.exit(1);
}

let readme;
try {
  readme = readFileSync(readmePath, 'utf8');
} catch (e) {
  console.error(`gen-readme-recent: failed to read README.md — ${e.message}`);
  process.exit(1);
}

// ── Read git tags + current package.json version ───────────────────────────
// Filter CHANGELOG entries to only versions that have actually shipped (have
// a `vX.Y.Z` git tag) OR the in-flight version currently in package.json
// (which gets bumped by `npm version` and is about to be tagged in the same
// `version` lifecycle hook this script runs from).
//
// Without this filter, an in-flight CHANGELOG entry on dev (added in
// preparation for a future release but not yet promoted) would appear in
// README's "Recent releases" block — and worse, two such stacked release
// commits guaranteed a merge-back conflict on every promote, because each
// commit rewrites the whole 5-line block with different content. Tag-aware
// filtering means dev's README only contains shipped versions; the in-flight
// version gets added during promote (when package.json's version is bumped)
// and pushed via the version-bump commit. See RELEASING.md.
let tagSet = null;
try {
  // execFileSync (no shell) so the `v*` glob isn't eaten by shell
  // expansion on systems where unmatched globs surface as empty.
  const tagOutput = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' });
  tagSet = new Set();
  for (const line of tagOutput.split('\n')) {
    const m = line.trim().match(/^v(\d+\.\d+\.\d+)$/);
    if (m) tagSet.add(m[1]);
  }
} catch {
  // Not in a git checkout (rare — packaging contexts, fresh tarball).
  // Fall through with tagSet=null → no filtering, behave like pre-fix.
  tagSet = null;
}

let currentVersion = null;
try {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  currentVersion = pkg.version ?? null;
} catch {
  currentVersion = null;
}

// ── Parse CHANGELOG headers ──────────────────────────────────────────────────
// Mirrors website/main.py:recent_releases — same precedence: version mandatory,
// optional date, optional title. CHANGELOG sometimes has multiple v1.7.8
// entries (intentional during in-flight releases) — we deduplicate by version
// keeping the FIRST occurrence (= most-recent at top of file = the entry the
// release notes / git tag will point at).
const HEADER_RE = /^## v(?<ver>\d+\.\d+\.\d+)(?: — (?<date>\d{4}-\d{2}-\d{2}))?(?: — (?<title>.+))?$/gm;

const seen = new Set();
const bullets = [];
for (const match of changelog.matchAll(HEADER_RE)) {
  const { ver, date, title } = match.groups;
  if (seen.has(ver)) continue;       // dedupe duplicate entries for same version

  // Tag-aware filter: only include versions that have shipped (tagged) OR
  // the in-flight version currently in package.json. Skip silently if
  // tagSet is null (no git available — fall back to pre-fix behaviour).
  if (tagSet !== null && !tagSet.has(ver) && ver !== currentVersion) continue;

  seen.add(ver);

  const parts = [`**v${ver}**`];
  if (date) parts.push(`(${date})`);
  if (title) parts.push(`— ${title.trim()}`);
  bullets.push(`- ${parts.join(' ')}`);
  if (bullets.length >= N_RECENT) break;
}

if (bullets.length === 0) {
  console.error(
    `gen-readme-recent: no version headers matching /^## v\\d+\\.\\d+\\.\\d+/ in docs/CHANGELOG.md.`,
  );
  process.exit(1);
}

const replacement = bullets.join('\n');

// ── Splice into README between markers ───────────────────────────────────────
const startIdx = readme.indexOf(MARKER_START_PREFIX);
const endIdx   = readme.indexOf(MARKER_END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(
    `gen-readme-recent: README.md is missing the GENERATED:recent-releases markers. ` +
    `Expected:\n  ${MARKER_START_PREFIX} ... -->\n  ...content...\n  ${MARKER_END}`,
  );
  process.exit(1);
}

// Find end of the start-marker line (so we keep the marker + its trailing -->)
const startLineEnd = readme.indexOf('\n', startIdx);
const before = readme.slice(0, startLineEnd + 1);
const after  = readme.slice(endIdx);
const next   = `${before}${replacement}\n${after}`;

// ── Apply or check ───────────────────────────────────────────────────────────
if (CHECK_MODE) {
  if (next === readme) {
    console.log(`gen-readme-recent --check: README.md is up to date.`);
    process.exit(0);
  }
  console.error(
    `gen-readme-recent --check: README.md is OUT OF SYNC with docs/CHANGELOG.md. ` +
    `Run \`npm run gen-readme-recent\` to update.`,
  );
  process.exit(1);
}

if (next === readme) {
  console.log(`gen-readme-recent: README.md is already up to date — no write.`);
  process.exit(0);
}
writeFileSync(readmePath, next);
console.log(`gen-readme-recent: wrote ${bullets.length} entries to README.md.`);
