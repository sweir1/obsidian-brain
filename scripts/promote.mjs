#!/usr/bin/env node
/**
 * promote.mjs — one-command dev → main release script (cherry-pick flow).
 *
 * How it works:
 *   1. Assert current branch is `dev`, working tree is clean.
 *   2. Fetch origin.
 *   3. Run `npm run preflight` (mirrors `.github/workflows/ci.yml`:
 *      build + test:coverage + smoke + docs:build + gen-docs check +
 *      codespell). If any step fails, promote aborts before touching main.
 *      Skip with `--skip-preflight` if you know what you're doing.
 *   4. Resolve target ref (default: dev HEAD). Validate it's reachable
 *      from dev.
 *   5. Compute pending commits via `git cherry origin/main <target>` —
 *      commits reachable from <target> that are NOT patch-id-equivalent
 *      to anything already on main. This auto-skips content shipped in
 *      earlier promotes, so subsequent cherry-pick releases Just Work™
 *      without any tracking ref.
 *   6. If `--dry-run`, print what would happen and exit 0.
 *   7. Checkout main, pull --ff-only.
 *   8. For each pending commit in order: `git cherry-pick -x <sha>`.
 *      The `-x` trailer records the origin SHA in the commit message.
 *      On conflict: abort with a resolution hint, leaving main in the
 *      conflicted state so you can fix or `--abort`.
 *   9. `npm version <bump>` on main — bumps package.json + server.json
 *      (via the `version` hook) and pushes main + tag (via `postversion`).
 *   10. Checkout dev. Do NOT modify or push dev — stable SHAs forever.
 *
 * Dev's `package.json` lags behind main's releases in this flow.
 * Nothing reads dev's version at runtime; publish-time CI overrides it
 * from the tag. One-liner to manually sync if you want: `npm version
 * <ver> --no-git-tag-version --allow-same-version && git commit -am
 * "chore: sync dev"`.
 *
 * Safety:
 *   - FF-only pull of main; never non-ff merges.
 *   - Clean-tree assertion prevents tagging with uncommitted changes.
 *   - Branch assertion prevents running from main by muscle memory.
 *   - `npm version` fires the existing `version` + `postversion` hooks.
 *   - No `git rebase`, no `--force-with-lease`, no dev force-push ever.
 *
 * Usage:
 *   npm run promote -- <commit>                  # patch, ship up to <commit>
 *   npm run promote -- minor <commit>            # minor, ship up to <commit>
 *   npm run promote -- major <commit>            # major, ship up to <commit>
 *   npm run promote -- --dry-run <commit>        # preview, no mutation
 *   npm run promote -- --skip-preflight <commit> # bypass preflight (rare)
 *   npm run promote -- <commit> minor            # args order-independent
 *
 * A <commit> ref is REQUIRED. The script refuses to default to dev HEAD so
 * you can't accidentally ship everything on dev with an empty-handed
 * invocation. To ship all of dev, explicitly pass the HEAD sha:
 *   git log dev --oneline -1          # find it
 *   npm run promote -- <that-sha>     # ship it
 *
 * <commit> can be any git ref: full SHA, short SHA, tag, branch. Must be
 * reachable from dev.
 *
 * Flags `--patch` / `--minor` / `--major` also work (leading dashes are
 * stripped for convenience).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

// --- Parse args — order-independent ---
let bump = 'patch';
let targetRef = null;
let dryRun = false;
let skipPreflight = false;

for (const raw of process.argv.slice(2)) {
  // Skip the bare "--" separator (npm inserts one; users may also pass one).
  if (raw === '--') continue;
  if (raw === '--dry-run') {
    dryRun = true;
    continue;
  }
  if (raw === '--skip-preflight') {
    skipPreflight = true;
    continue;
  }
  const arg = raw.replace(/^--?/, '');
  if (VALID_BUMPS.has(arg)) {
    bump = arg;
  } else if (raw.startsWith('-')) {
    console.error(`promote: unknown flag "${raw}". Valid flags: --patch, --minor, --major, --dry-run, --skip-preflight.`);
    process.exit(1);
  } else if (targetRef !== null) {
    console.error(`promote: got two non-bump args ("${targetRef}" and "${raw}"). Expected at most one commit ref.`);
    process.exit(1);
  } else {
    targetRef = raw;
  }
}

/** Run a command, streaming output to the terminal. Throws on non-zero exit. */
function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

/** Run a command and return trimmed stdout. Throws on non-zero exit. */
function capture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

/** Run a command and return true iff it exits 0 (swallows stderr). */
function tryRun(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- 1. Assert current branch is `dev` ---
const currentBranch = capture('git rev-parse --abbrev-ref HEAD');
if (currentBranch !== 'dev') {
  console.error(`promote: must be run from the "dev" branch. Currently on "${currentBranch}".`);
  process.exit(1);
}

// --- 2. Assert working tree is clean ---
const dirty = capture('git status --porcelain');
if (dirty.length > 0) {
  console.error('promote: working tree is not clean. Commit or stash changes first.');
  console.error(dirty);
  process.exit(1);
}

// --- 3. Fetch origin ---
console.log('promote: fetching origin…');
run('git fetch origin');

// --- 4. Run preflight (mirrors ci.yml) — the mandatory CI gate ---
if (skipPreflight) {
  console.log('\npromote: ⚠ --skip-preflight set — bypassing local CI mirror. Your release may fail CI post-tag.');
} else {
  console.log('\npromote: running preflight (mirrors ci.yml — build + tests + smoke + docs)…');
  try {
    run('npm run preflight');
  } catch {
    console.error('\npromote: preflight failed. Fix the red step above, then re-run promote.');
    console.error('         (add --skip-preflight to bypass, not recommended)');
    process.exit(1);
  }
}

// --- 5. Resolve target (REQUIRED — no implicit dev HEAD) + validate reachability ---
if (targetRef === null) {
  console.error('promote: a target commit is required. The script refuses to default to');
  console.error('         dev HEAD so you can\'t accidentally ship everything on dev.');
  console.error('');
  console.error('  Usage: npm run promote -- <sha>');
  console.error('');
  console.error('  To ship all of dev, find HEAD explicitly and pass it:');
  console.error('    git log dev --oneline -1');
  console.error('    npm run promote -- <that-sha>');
  process.exit(1);
}

const devHead = capture('git rev-parse dev');
let targetSha;
let targetShort;

try {
  targetSha = capture(`git rev-parse ${targetRef}^{commit}`);
} catch {
  console.error(`promote: "${targetRef}" is not a valid commit ref.`);
  process.exit(1);
}
targetShort = capture(`git rev-parse --short ${targetSha}`);

if (!tryRun(`git merge-base --is-ancestor ${targetSha} dev`)) {
  console.error(`promote: commit ${targetShort} is not reachable from dev.`);
  console.error(`  It must be an ancestor of (or equal to) dev's HEAD.`);
  process.exit(1);
}

// --- 6. Compute pending commits via `git cherry origin/main <target>` ---
// `+` = reachable from <target>, not yet on main (by patch-id) → cherry-pick
// `-` = already on main (patch-id match) → skip (shipped in an earlier promote)
const cherryOutput = capture(`git cherry origin/main ${targetSha}`);
const pending = cherryOutput
  .split('\n')
  .filter((l) => l.startsWith('+ '))
  .map((l) => l.slice(2).trim())
  .filter((s) => s.length > 0);

if (pending.length === 0) {
  console.error(`promote: nothing to ship — all commits up to ${targetShort} are already on main (by patch-id).`);
  process.exit(1);
}

console.log(`\npromote: target is ${targetShort}${targetSha === devHead ? ' (dev HEAD)' : ' (cherry-pick)'}.`);
console.log(`promote: ${pending.length} pending commit(s) to cherry-pick onto main (bump=${bump}):`);
for (const sha of pending) {
  const short = capture(`git rev-parse --short ${sha}`);
  const subject = capture(`git log -1 --format=%s ${sha}`);
  console.log(`  ${short}  ${subject}`);
}

// --- 7. If --dry-run, stop here — no mutation ---
if (dryRun) {
  console.log('\npromote: --dry-run — exiting without touching main or tagging.');
  process.exit(0);
}

// --- 8. Switch to main, pull FF-only ---
console.log('\npromote: switching to main…');
run('git checkout main');

console.log('promote: pulling main (ff-only)…');
run('git pull --ff-only origin main');

// --- 9. Cherry-pick each pending commit onto main ---
console.log(`\npromote: cherry-picking ${pending.length} commit(s) onto main…`);
for (const sha of pending) {
  const short = capture(`git rev-parse --short ${sha}`);
  console.log(`  cherry-picking ${short}…`);
  try {
    run(`git cherry-pick -x ${sha}`);
  } catch {
    console.error(`\npromote: cherry-pick of ${short} failed. Main is left in the conflicted state.`);
    console.error('         Resolve conflicts and run "git cherry-pick --continue",');
    console.error('         OR abort with "git cherry-pick --abort" and investigate.');
    console.error('         After resolving, either finish manually (npm version <bump>) or');
    console.error('         reset main (git reset --hard origin/main) and re-run promote.');
    process.exit(1);
  }
}

// --- 10. Bump version — fires version + postversion hooks (pushes main+tag) ---
console.log(`\npromote: running npm version ${bump}…`);
run(`npm version ${bump}`);

// Read the new version after the bump
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const newPkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const newVersion = newPkg.version;

// --- 11. Return to dev. NO modifications, NO push. ---
console.log('\npromote: returning to dev…');
run('git checkout dev');

// --- 12. Summary ---
console.log(`
promote: done.
  Tagged:  v${newVersion} at the new cherry-pick chain on main
  main:    +${pending.length} cherry-picked commit(s) + bump commit, linear, pushed with tag
  dev:     untouched — stable SHAs preserved for future promotes
  CI:      release.yml will fire on tag push → npm + MCP Registry + GitHub Release

Note: dev's package.json still shows the previous version. Main is authoritative
  at v${newVersion}. If you want dev's file synced, run:
    npm version ${newVersion} --no-git-tag-version --allow-same-version
    git commit -am "chore: sync dev package.json to v${newVersion}"
    git push origin dev
`);
