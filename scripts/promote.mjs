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

// --- 4a. STALE-DEV-SHIPPED DRIFT GUARD ------------------------------------
//
// `npm version` produces a commit on main whose subject is the bare version
// string (e.g. "1.7.0", "1.7.1", "1.7.2") because npm's default commit
// template is "%s". That commit gets merged back into dev — preserving its
// subject — and lands on dev's first-parent line as a "version-bump
// merge-back" anchor for "vX.Y.Z has shipped".
//
// If we find ANY such anchor between `base` (the dev-shipped tag) and
// `target`, that means at least one full release has shipped via some path
// (manual cherry-picks, an earlier promote.mjs revision, hand-run npm
// version, ...) WITHOUT updating the dev-shipped tag. Cherry-picking that
// range will then collide with main's existing state — main already has the
// patches under different SHAs (cherry-pick rewrites SHAs).
//
// This guard catches the failure mode the v1.7.5 promote attempt hit:
// dev-shipped at 4501b20 (pre-v1.7.0), main at v1.7.2, promote tried to
// cherry-pick all of v1.7.0/v1.7.1/v1.7.2's commits onto main and immediately
// conflicted on test/tools/index-status.test.ts.
const VERSION_BUMP_RE = /^v?\d+\.\d+\.\d+$/;
const versionBumpsRaw = capture(
  `git log --first-parent --reverse --format=%H%x09%s ${base}..${targetSha}`,
);
const versionBumpsBetween = versionBumpsRaw
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => {
    const tabIdx = line.indexOf('\t');
    return { sha: line.slice(0, tabIdx), subject: line.slice(tabIdx + 1) };
  })
  .filter(({ subject }) => VERSION_BUMP_RE.test(subject));

if (versionBumpsBetween.length > 0) {
  const newest = versionBumpsBetween[versionBumpsBetween.length - 1];
  const newestShort = capture(`git rev-parse --short ${newest.sha}`);

  console.error('');
  console.error('promote: ✗ STALE dev-shipped TAG DETECTED — refusing to cherry-pick.');
  console.error('');
  console.error(`  dev-shipped is at ${baseShort}.`);
  console.error(`  But ${versionBumpsBetween.length} version-bump merge-back commit(s) exist between`);
  console.error(`  dev-shipped and your target (${targetShort}) on dev's first-parent line:`);
  for (const vb of versionBumpsBetween) {
    const sh = capture(`git rev-parse --short ${vb.sha}`);
    console.error(`    ${sh}  ${vb.subject}`);
  }
  console.error('');
  console.error(`  Each "${newest.subject}"-style subject is the merge-back of an \`npm version\``);
  console.error('  bump commit from main — i.e., that version has ALREADY BEEN PUBLISHED to npm');
  console.error('  (its cherry-pick twin sits on main under a different SHA). Re-cherry-picking');
  console.error('  the range will conflict because main already has those same patches.');
  console.error('');
  console.error('  Fix: advance dev-shipped to the most recent shipped version-bump merge-back,');
  console.error('  then retry. The right SHA is the newest version-bump anchor in the list above:');
  console.error('');
  console.error(`    git tag -f dev-shipped ${newestShort}`);
  console.error('    git push -f origin refs/tags/dev-shipped');
  console.error(`    npm run promote -- ${bump !== 'patch' ? bump + ' ' : ''}${targetRef}`);
  console.error('');
  console.error('  See RELEASING.md → "Stale dev-shipped tag" for why this happens and how to');
  console.error('  prevent it (every release must update the tag — promote.mjs does this on its');
  console.error('  last step; the manual fallback flow has step 7 for the same purpose).');
  console.error('');
  process.exit(1);
}

// --------------------------------------------------------------------------

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
  // Expected conflict pattern under B5: dev carries CHANGELOG entries for
  // yet-to-ship future releases (v1.6.15 + v1.6.16 + ...) sitting above
  // the entry we just cherry-picked to main. Merging main back produces
  // a structural conflict where dev's side has the full list and main's
  // side has only the latest entry.
  //
  // Auto-resolve iff `docs/CHANGELOG.md` is the ONLY conflicted file —
  // keep dev's version (it has the superset of entries). Any other
  // conflicted file is a real merge conflict and must be resolved by hand.
  const conflicted = capture('git diff --name-only --diff-filter=U')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const autoResolveOnly =
    conflicted.length > 0 &&
    conflicted.every((f) => f === 'docs/CHANGELOG.md');

  if (autoResolveOnly) {
    console.log(
      '\npromote: merge-back conflict on docs/CHANGELOG.md only — auto-resolving with dev\'s version.',
    );
    console.log(
      '         (expected under B5: dev has CHANGELOG entries for future releases main doesn\'t have yet)',
    );
    run('git checkout --ours docs/CHANGELOG.md');
    run('git add docs/CHANGELOG.md');
    // Finish the merge using the default message git prepared.
    run('git commit --no-edit');
  } else {
    console.error(`\npromote: merge-back failed (conflict beyond CHANGELOG — manual resolve needed).`);
    console.error(`         Conflicted files:`);
    for (const f of conflicted) console.error(`           ${f}`);
    console.error(`         Resolve, stage, "git commit" to finish the merge, then:`);
    console.error(`           git push origin dev`);
    console.error(`           git tag -f dev-shipped ${targetSha}`);
    console.error(`           git push -f origin refs/tags/dev-shipped`);
    process.exit(1);
  }
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
