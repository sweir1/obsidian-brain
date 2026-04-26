#!/usr/bin/env node
/**
 * promote.mjs — one-command dev → main release (cherry-pick + merge-back, no
 * persistent state ref).
 *
 * How it works:
 *   1. Assert current branch is `dev`, working tree clean, fetch origin.
 *   2. Run `npm run preflight` (mirrors ci.yml). Skip with `--skip-preflight`.
 *   3. Resolve target ref (REQUIRED) and validate it's reachable from dev.
 *   4. Determine `base` for pending-commits computation:
 *        - Find the latest `vX.Y.Z` tag (semver-sorted descending).
 *        - That tag points at the version-bump commit on main. Its first
 *          parent is the LAST cherry-pick of that release.
 *        - That cherry-pick has a `(cherry picked from commit ORIGINAL_SHA)`
 *          trailer (added by `git cherry-pick -x` in step 7). The
 *          ORIGINAL_SHA is the dev SHA that was promoted — that's our base.
 *        - Falls back to `merge-base origin/main <target>` only on the very
 *          first promote (no tags yet) or if the trailer is missing.
 *      Then pending = `git log --first-parent --no-merges base..target`.
 *      This is DETERMINISTIC — relies only on immutable git tags + the
 *      cherry-pick `-x` trailer (the canonical pattern for tracking
 *      promoted commits across branches; see git-cherry-pick docs).
 *   5. If `--dry-run`, print and exit.
 *   6. Checkout main, pull --ff-only.
 *   7. Cherry-pick each pending commit with `-x` (records origin SHA).
 *   8. `npm version <bump>` → version/postversion hooks bump package.json +
 *      server.json, commit, tag, push main + tag.
 *   9. Merge-back: checkout dev, `git merge --no-ff origin/main`, push dev.
 *      Non-FF by construction (main has cherry-picked twins, dev has
 *      originals). Merge commit brings main's version bump onto dev.
 *   10. (idempotent) Clean up any legacy `dev-shipped` ref (tag pre-v1.7.16,
 *       branch v1.7.16 only). The new logic doesn't use it.
 *
 * What was eliminated as of v1.7.17:
 *   - The `dev-shipped` tag (pre-v1.7.16) and branch (v1.7.16 only).
 *   - All advance/push/force-push operations for that ref.
 *   - The stale-ref drift guard (drift can't happen if there's no ref).
 *   - The `git cherry` patch-id guesswork (still avoided — we use tag +
 *     trailer extraction, which can't lie about what shipped).
 *
 * Safety:
 *   - FF-only pull of main; never non-ff onto main.
 *   - Clean-tree assertion; branch assertion.
 *   - `npm version` fires the existing `version` + `postversion` hooks.
 *   - Merge-back is a plain push to dev (no force).
 *   - Zero force-pushes anywhere in the happy path.
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

// --- 4. Determine base from the latest version tag's cherry-pick trailer ---
//
// Eliminated as of v1.7.17:
//   - refs/heads/dev-shipped (branch, v1.7.16 only)
//   - refs/tags/dev-shipped (tag, pre-v1.7.16)
//   - All advance + push operations for that ref
//   - The stale-ref drift guard (drift can't happen without a ref to drift)
//
// Strategy:
//   1. Find the latest `vX.Y.Z` tag (semver-sorted descending).
//   2. The tag points at the version-bump commit on main (subject e.g.
//      "1.7.16" — npm's default commit template).
//   3. The bump commit's first parent is the LAST cherry-pick on main for
//      that release. With `git cherry-pick -x` (used by step 7 of this
//      script), every cherry-pick has a `(cherry picked from commit
//      ORIGINAL_SHA)` trailer.
//   4. Extract that ORIGINAL_SHA — it's the dev SHA that was last
//      promoted. Use it as the base for the new pending range.
//
// The cherry-pick `-x` trailer is the canonical pattern for tracking
// promoted commits across branches — see git-cherry-pick docs and
// Atlassian's release-branch tutorial.
let base;
let baseSource;

const allTagsRaw = tryRun('git tag -l "v*"')
  ? capture('git tag -l "v*"')
  : '';
const versionTags = allTagsRaw
  .split('\n')
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t.trim()))
  .map((t) => {
    const [maj, min, pat] = t.trim().slice(1).split('.').map(Number);
    return { tag: t.trim(), key: maj * 1_000_000 + min * 1_000 + pat };
  })
  .sort((a, b) => b.key - a.key);

if (versionTags.length > 0) {
  const latest = versionTags[0].tag;
  // Tag → bump commit → its first parent = last cherry-pick on main.
  let bumpSha;
  try {
    bumpSha = capture(`git rev-parse ${latest}^{commit}`);
  } catch {
    bumpSha = null;
  }
  if (bumpSha) {
    let lastCherryPickSha;
    try {
      lastCherryPickSha = capture(`git rev-parse ${bumpSha}^1`);
    } catch {
      lastCherryPickSha = null;
    }
    if (lastCherryPickSha) {
      const body = capture(`git log -1 --format=%B ${lastCherryPickSha}`);
      const trailerMatch = body.match(/\(cherry picked from commit ([0-9a-f]{7,40})\)/);
      if (trailerMatch) {
        try {
          base = capture(`git rev-parse ${trailerMatch[1]}`);
          baseSource = `${latest} cherry-pick origin (extracted from -x trailer)`;
        } catch {
          base = null;
        }
      }
    }
  }
}

if (!base) {
  base = capture(`git merge-base origin/main ${targetSha}`);
  baseSource = 'merge-base origin/main (no version tag yet, or trailer not found)';
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
    process.exit(1);
  }
}

console.log('promote: pushing dev…');
run('git push origin dev');

// --- 10. One-time cleanup of any legacy dev-shipped ref (tag or branch) ---
//
// As of v1.7.17, base SHA is computed from dev's first-parent chain
// (looking for the most recent version-bump anchor), not from a stored
// dev-shipped ref. If a legacy ref exists locally or on origin from
// pre-v1.7.17 promotes, delete it. Idempotent — no-op once gone.
if (tryRun('git rev-parse refs/heads/dev-shipped')) {
  console.log('promote: removing legacy dev-shipped branch (replaced by version-bump anchor scan)…');
  run('git branch -D dev-shipped');
  tryRun('git push origin :dev-shipped');
}
if (tryRun('git rev-parse refs/tags/dev-shipped')) {
  console.log('promote: removing legacy dev-shipped tag…');
  run('git tag -d dev-shipped');
  tryRun('git push origin :refs/tags/dev-shipped');
}

// --- Summary ---
console.log(`
promote: done.
  Tagged:       v${newVersion} on main (linear, cherry-pick chain)
  main:         +${pending.length} cherry-picked commit(s) + bump commit + tag, pushed
  dev:          merge-back commit "chore: merge v${newVersion} into dev", pushed
  CI:           release.yml fires on the tag, waits for ci.yml green on SHA, then publishes

dev is now "N ahead / 0 behind" main on GitHub, where N = any dev work past
${targetShort} on first-parent chain + 1 merge commit.
`);
