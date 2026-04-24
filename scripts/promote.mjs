#!/usr/bin/env node
/**
 * promote.mjs — one-command dev → main release (B5: tag-tracked cherry-pick + merge-back).
 *
 * How it works:
 *   1. Assert current branch is `dev`, working tree clean, fetch origin.
 *   2. Run `npm run preflight` (mirrors ci.yml). Skip with `--skip-preflight`.
 *   3. Resolve target ref (REQUIRED) and validate it's reachable from dev.
 *   4. Determine `base` for pending-commits computation:
 *        - If refs/tags/dev-shipped exists: base = dev-shipped.
 *        - Else (first run after cleanup): base = merge-base(origin/main, target).
 *      Then pending = `git log --first-parent --no-merges base..target`.
 *      This is DETERMINISTIC — no `git cherry` patch-id guesswork. Immune
 *      to past cherry-pick conflict reshaping (the failure that produced
 *      the 7 phantom pending commits in the v1.6.14 attempt).
 *   5. If `--dry-run`, print and exit.
 *   6. Checkout main, pull --ff-only.
 *   7. Cherry-pick each pending commit with `-x`.
 *   8. `npm version <bump>` → version/postversion hooks bump package.json +
 *      server.json, commit, tag, push main + tag.
 *   9. Merge-back: checkout dev, `git merge --no-ff origin/main`, push dev.
 *      Non-FF by construction (main has cherry-picked twins, dev has
 *      originals). Merge commit brings main's version bump onto dev.
 *   10. Force-update the `dev-shipped` tag locally and on origin. This is
 *       a TAG force-update, not a branch force-push — the dev branch
 *       ruleset (`refs/heads/dev`) doesn't apply to `refs/tags/*`.
 *
 * Why the dev-shipped tag:
 *   `git cherry` breaks whenever a past cherry-pick resolved conflicts
 *   (reshaping the landed diff) or a ghost-generating workflow was fixed
 *   (reshaping dev-side diffs). That's what happened during v1.6.14:
 *   12 "pending" commits, 7 false positives. Explicit tag tracking
 *   sidesteps patch-id entirely — pending is just commits between two
 *   refs on dev's first-parent chain.
 *
 * Safety:
 *   - FF-only pull of main; never non-ff onto main.
 *   - Clean-tree assertion; branch assertion.
 *   - `npm version` fires the existing `version` + `postversion` hooks.
 *   - Merge-back is a plain push to dev (no force). Dev's ruleset permits
 *     plain pushes.
 *   - Tag force-update is the ONLY force operation, and it targets a tag
 *     (refs/tags/dev-shipped), not a branch. Rulesets don't apply.
 *
 * Usage:
 *   npm run promote -- <commit>                  # patch, ship up to <commit>
 *   npm run promote -- minor <commit>            # minor bump
 *   npm run promote -- major <commit>            # major bump
 *   npm run promote -- --dry-run <commit>        # preview, no mutation
 *   npm run promote -- --skip-preflight <commit> # bypass preflight (rare)
 *
 * <commit> is REQUIRED. Must be an ancestor of dev's HEAD on the first-
 * parent chain (the trunk of dev, ignoring merge-commit second-parents).
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
  if (raw === '--') continue;
  if (raw === '--dry-run') { dryRun = true; continue; }
  if (raw === '--skip-preflight') { skipPreflight = true; continue; }
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

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
function capture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}
function tryRun(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

// --- 1. Assert on dev, clean tree, fetch ---
const currentBranch = capture('git rev-parse --abbrev-ref HEAD');
if (currentBranch !== 'dev') {
  console.error(`promote: must be run from the "dev" branch. Currently on "${currentBranch}".`);
  process.exit(1);
}

const dirty = capture('git status --porcelain');
if (dirty.length > 0) {
  console.error('promote: working tree is not clean. Commit or stash changes first.');
  console.error(dirty);
  process.exit(1);
}

console.log('promote: fetching origin…');
run('git fetch origin');

// --- 2. Preflight ---
if (skipPreflight) {
  console.log('\npromote: ⚠ --skip-preflight set — bypassing local CI mirror.');
} else {
  console.log('\npromote: running preflight…');
  try {
    run('npm run preflight');
  } catch {
    console.error('\npromote: preflight failed. Fix the red step above, then re-run.');
    process.exit(1);
  }
}

// --- 3. Target ref is REQUIRED ---
if (targetRef === null) {
  console.error('promote: a target commit is required.');
  console.error('  Usage: npm run promote -- <sha>');
  console.error('  To ship all of dev, find HEAD explicitly:');
  console.error('    git log dev --oneline -1');
  console.error('    npm run promote -- <that-sha>');
  process.exit(1);
}

let targetSha;
try {
  targetSha = capture(`git rev-parse ${targetRef}^{commit}`);
} catch {
  console.error(`promote: "${targetRef}" is not a valid commit ref.`);
  process.exit(1);
}
const targetShort = capture(`git rev-parse --short ${targetSha}`);

if (!tryRun(`git merge-base --is-ancestor ${targetSha} dev`)) {
  console.error(`promote: commit ${targetShort} is not reachable from dev.`);
  process.exit(1);
}

// --- 4. Determine base + compute pending via deterministic first-parent walk ---
let base;
let baseSource;
if (tryRun('git rev-parse refs/tags/dev-shipped')) {
  base = capture('git rev-parse refs/tags/dev-shipped');
  baseSource = 'dev-shipped tag';
} else {
  base = capture(`git merge-base origin/main ${targetSha}`);
  baseSource = 'merge-base (dev-shipped tag not yet seeded)';
}
const baseShort = capture(`git rev-parse --short ${base}`);

// Ensure target is reachable from base on dev's first-parent chain, and
// that target is NOT already at or behind base.
if (base === targetSha) {
  console.error(`promote: nothing to ship — ${targetShort} is already at the last-promoted commit (${baseShort}).`);
  process.exit(1);
}
if (tryRun(`git merge-base --is-ancestor ${targetSha} ${base}`)) {
  console.error(`promote: target ${targetShort} is behind the last-promoted commit (${baseShort}).`);
  console.error('         Nothing to do. Check that you passed the right sha.');
  process.exit(1);
}

const pendingRaw = capture(
  `git log --first-parent --no-merges --reverse --format=%H ${base}..${targetSha}`,
);
const pending = pendingRaw.split('\n').filter((s) => s.length > 0);

if (pending.length === 0) {
  console.error(`promote: nothing to ship — no non-merge commits on dev's first-parent trunk between ${baseShort} and ${targetShort}.`);
  process.exit(1);
}

console.log(`\npromote: target ${targetShort}, base ${baseShort} (${baseSource}).`);
console.log(`promote: ${pending.length} pending commit(s) to cherry-pick onto main (bump=${bump}):`);
for (const sha of pending) {
  const short = capture(`git rev-parse --short ${sha}`);
  const subject = capture(`git log -1 --format=%s ${sha}`);
  console.log(`  ${short}  ${subject}`);
}

// --- 5. Dry-run exit ---
if (dryRun) {
  console.log('\npromote: --dry-run — exiting without touching main, dev, or tags.');
  process.exit(0);
}

// --- 6. Switch to main, pull FF ---
console.log('\npromote: switching to main…');
run('git checkout main');
console.log('promote: pulling main (ff-only)…');
run('git pull --ff-only origin main');

// --- 7. Cherry-pick each pending commit onto main ---
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

// --- 8. Bump version — fires version + postversion hooks (pushes main+tag) ---
console.log(`\npromote: running npm version ${bump}…`);
run(`npm version ${bump}`);

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const newPkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const newVersion = newPkg.version;

// --- 9. Merge-back: bring main's new tip onto dev (non-FF, plain push) ---
console.log(`\npromote: merge-back — switching to dev and merging origin/main…`);
run('git checkout dev');
run('git fetch origin main');

// --- `--no-ff` forces a merge commit even if FF were possible (it won't
//     be here — cherry-pick gave main different SHAs than dev's originals,
//     so main is NEVER an ancestor of dev at this point). Explicit is safer.
// --- The merge should be conflict-free: dev's content is already the
//     source of the cherry-picked twins on main, and the only new content
//     on main since the last merge-back is the version bump commit (which
//     touches package.json's `.version` + server.json's `.version` fields
//     — non-overlapping with anything dev commits produce under normal
//     usage).
try {
  run(`git merge --no-ff origin/main -m "chore: merge v${newVersion} into dev"`);
} catch {
  console.error(`\npromote: merge-back failed (conflict). Resolve the conflict, stage,`);
  console.error(`         and run "git commit" to finish the merge, then run`);
  console.error(`         "git push origin dev" and update the dev-shipped tag manually:`);
  console.error(`           git tag -f dev-shipped ${targetSha}`);
  console.error(`           git push -f origin refs/tags/dev-shipped`);
  process.exit(1);
}

console.log('promote: pushing dev…');
run('git push origin dev');

// --- 10. Update the dev-shipped tracking tag ---
console.log(`promote: updating dev-shipped tag → ${targetShort}…`);
run(`git tag -f dev-shipped ${targetSha}`);
run('git push -f origin refs/tags/dev-shipped');

// --- Summary ---
console.log(`
promote: done.
  Tagged:       v${newVersion} on main (linear, cherry-pick chain)
  main:         +${pending.length} cherry-picked commit(s) + bump commit + tag, pushed
  dev:          merge-back commit "chore: merge v${newVersion} into dev", pushed
  dev-shipped:  ${targetShort}
  CI:           release.yml fires on the tag, waits for ci.yml green on SHA, then publishes

dev is now "N ahead / 0 behind" main on GitHub, where N = any dev work past
${targetShort} on first-parent chain + 1 merge commit.
`);
