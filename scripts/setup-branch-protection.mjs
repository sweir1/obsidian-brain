#!/usr/bin/env node
/**
 * setup-branch-protection.mjs — apply GitHub rulesets to main and dev.
 *
 * Idempotent: re-run safely. Rulesets are looked up by name and updated in
 * place rather than duplicated.
 *
 * Design: two rulesets on main, one on dev.
 *
 *   obsidian-brain/main (hard rules — nobody bypasses, including admin):
 *     - Block force-push         (non_fast_forward)
 *     - Block deletion           (deletion)
 *
 *   obsidian-brain/main-workflow (workflow rules — admin can bypass):
 *     - Require linear history   (required_linear_history)
 *     - Require pull request     (pull_request, 0 approvals needed)
 *     - Require CI to pass       (required_status_checks: "Build, test, smoke, docs")
 *
 *     Admin bypass is required so `npm run promote` can push its bump
 *     commit directly to main without (a) opening a PR for the version
 *     bump and (b) waiting for CI. Non-admin actors (Dependabot, future
 *     contributors) must open a PR and pass CI to merge — direct pushes
 *     from non-admin are blocked by the pull_request rule.
 *
 *   obsidian-brain/dev:
 *     - Block deletion
 *     (Force-push intentionally allowed — the cherry-pick branch of
 *     `npm run promote` rebases dev onto main and uses --force-with-lease.)
 *
 * Required status check context:  "Build, test, smoke, docs"
 *   This is the `name:` of the sole job in .github/workflows/ci.yml. If that
 *   job is ever renamed, update this script and re-run `npm run setup:protection`.
 *
 * Usage:
 *   npm run setup:protection
 *   npm run setup:protection -- --dry-run       # print the API calls, don't send
 *   npm run setup:protection -- --no-ci-check   # omit required-CI rule (for red-CI periods)
 *
 * Requires: `gh` CLI authenticated as a repo admin.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'sweir1/obsidian-brain';
const DRY = process.argv.includes('--dry-run');
const SKIP_CI = process.argv.includes('--no-ci-check');

/** Role ID 5 = admin in GitHub's RepositoryRole enum. */
const ADMIN_BYPASS = [
  { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
];

function run(cmd) {
  if (DRY) {
    console.log(`[dry-run] ${cmd}`);
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

function upsertRuleset(ruleset) {
  const name = ruleset.name;
  const existing = JSON.parse(
    execSync(`gh api repos/${REPO}/rulesets`, { encoding: 'utf8' }),
  );
  const match = existing.find((r) => r.name === name);

  const tmp = join(tmpdir(), `ruleset-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(tmp, JSON.stringify(ruleset));

  try {
    if (match) {
      console.log(`updating existing ruleset "${name}" (id ${match.id})`);
      run(`gh api --method PUT repos/${REPO}/rulesets/${match.id} --input ${tmp}`);
    } else {
      console.log(`creating new ruleset "${name}"`);
      run(`gh api --method POST repos/${REPO}/rulesets --input ${tmp}`);
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

const mainHardRuleset = {
  name: 'obsidian-brain/main',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['refs/heads/main'], exclude: [] },
  },
  rules: [
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ],
};

const mainWorkflowRules = [
  { type: 'required_linear_history' },
  {
    // Require every change to main to go through a PR. Combined with admin
    // bypass below, this blocks direct `git push origin main` from any
    // non-admin collaborator while keeping `npm run promote` working (promote
    // runs as admin and bypasses). required_approving_review_count: 0 means
    // PRs don't need a reviewer's approval — solo maintainer workflow. Set
    // higher if contributors join.
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
    },
  },
];
if (!SKIP_CI) {
  mainWorkflowRules.push({
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [
        { context: 'Build, test, smoke, docs' },
      ],
      strict_required_status_checks_policy: false,
    },
  });
}

const mainWorkflowRuleset = {
  name: 'obsidian-brain/main-workflow',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: ADMIN_BYPASS,
  conditions: {
    ref_name: { include: ['refs/heads/main'], exclude: [] },
  },
  rules: mainWorkflowRules,
};

const devRuleset = {
  name: 'obsidian-brain/dev',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['refs/heads/dev'], exclude: [] },
  },
  rules: [
    { type: 'deletion' },
  ],
};

console.log(`setup-branch-protection: target repo = ${REPO}${DRY ? ' (DRY RUN)' : ''}${SKIP_CI ? ' (SKIP CI CHECK)' : ''}\n`);
upsertRuleset(mainHardRuleset);
upsertRuleset(mainWorkflowRuleset);
upsertRuleset(devRuleset);

console.log(`
setup-branch-protection: done.

Applied:
  main (hard):     block force-push, block deletion
                   — no bypass; admin cannot override
  main (workflow): require linear history, require pull request${SKIP_CI ? '' : ', require CI "Build, test, smoke, docs" to pass'}
                   — admin bypasses so \`npm run promote\` works
  dev:             block deletion
                   — force-push allowed for promote's cherry-pick rebase

Verify at: https://github.com/${REPO}/settings/rules

Rollback a specific ruleset:
  gh api --method DELETE repos/${REPO}/rulesets/<id>

Disable temporarily (for emergencies):
  gh api --method PUT repos/${REPO}/rulesets/<id> -f enforcement=disabled
`);
