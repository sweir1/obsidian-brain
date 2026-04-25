#!/usr/bin/env node
/**
 * preflight.mjs — single-command readiness check before `npm run promote`.
 *
 * Runs, in order (mirrors `.github/workflows/ci.yml`):
 *   1. gen-docs --check         (docs/configuration.md in sync with server.json)
 *   2. gen-tools-docs --check   (docs/tools.md in sync with Zod schemas)
 *   3. check-plugin             (plugin manifest major.minor matches)
 *   4. check-env-vars           (process.env.X reads in src/ all declared in server.json)
 *   5. build                    (tsc — type-check + emit dist/)
 *   6. tests + coverage         (vitest run with V8 coverage gate)
 *   7. smoke                    (scripts/mcp-smoke.ts — end-to-end MCP client)
 *   8. docs:build               (MkDocs strict build — broken links / anchors)
 *   9. codespell                (spell check on docs + README + RELEASING)
 *
 * Each step streams its output live. At the end, prints a pass/fail summary
 * with timings + a git-state footer. Exits 1 if any REQUIRED step failed.
 *
 * `codespell` is a best-effort step: if the `codespell` binary isn't on PATH,
 * we warn and skip rather than fail (pip install codespell to enable it).
 * Everything else is required.
 *
 * `npm run promote` invokes this script as its first step automatically.
 * You can still run it standalone if you want to check readiness without
 * kicking off a release.
 */
import { spawnSync, execSync } from 'node:child_process';

// NOTE: if you change a `cmd`/`args` invocation below (flags, env, script name),
// also update the matching step in `.github/workflows/ci.yml` — the two places
// must stay in sync or CI and local will drift.
const STEPS = [
  { name: 'gen-docs (check)',       cmd: 'npm',       args: ['run', 'gen-docs', '--', '--check'] },
  { name: 'gen-tools-docs (check)', cmd: 'npm',       args: ['run', 'gen-tools-docs', '--', '--check'] },
  { name: 'check-plugin',           cmd: 'npm',       args: ['run', 'check-plugin'] },
  { name: 'check-env-vars',         cmd: 'npm',       args: ['run', 'check-env-vars'] },
  { name: 'build (tsc)',            cmd: 'npm',       args: ['run', 'build'] },
  { name: 'tests + coverage',       cmd: 'npm',       args: ['run', 'test:coverage'] },
  // Python unit tests for scripts/build-seed.py — pure-logic tests with
  // stdlib unittest, no `mteb` dependency. Catches filter / extract /
  // alias-table regressions that ship wrong prefixes or max_tokens to
  // every install via the bundled seed JSON.
  { name: 'test:python (build-seed)', cmd: 'npm',     args: ['run', 'test:python'] },
  { name: 'smoke (MCP client)',     cmd: 'npm',       args: ['run', 'smoke'] },
  { name: 'docs:build (strict)',    cmd: 'npm',       args: ['run', 'docs:build'] },
  { name: 'codespell',              cmd: 'codespell', args: ['docs/', 'README.md', 'RELEASING.md', '--skip=*.json,*.lock'], optional: true },
];

const BAR = '━'.repeat(60);
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

function tryGit(args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Return true iff `bin` resolves on PATH (POSIX `command -v`). */
function hasBin(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const results = [];
for (const step of STEPS) {
  process.stdout.write(`\n${BAR}\n▶ ${step.name}\n${BAR}\n`);

  // Optional step with a missing binary — warn + skip, don't fail the run.
  if (step.optional && !hasBin(step.cmd)) {
    console.log(`(skipped — ${step.cmd} not on PATH. \`pip install ${step.cmd}\` to enable.)`);
    results.push({ name: step.name, ok: true, skipped: true, ms: 0 });
    continue;
  }

  const t0 = Date.now();
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit' });
  const ms = Date.now() - t0;
  results.push({ name: step.name, ok: r.status === 0, ms });
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${BAR}\n  PREFLIGHT SUMMARY\n${BAR}`);
for (const r of results) {
  const mark = r.skipped ? '—' : r.ok ? '✓' : '✗';
  const suffix = r.skipped ? '  (skipped)' : `  ${fmt(r.ms)}`;
  console.log(`  ${mark}  ${r.name.padEnd(24)}${suffix}`);
}
const total = results.reduce((s, r) => s + r.ms, 0);
console.log(`  ${'·'.repeat(38)}`);
console.log(`     total${' '.repeat(22)}  ${fmt(total)}`);

// ── Git footer (informational) ────────────────────────────────────────────
const branch = tryGit('branch --show-current');
const status = tryGit('status --porcelain');
const ahead = tryGit('log @{u}..HEAD --oneline');
console.log(`\n  branch: ${branch || '(unknown)'}`);
console.log(`  tree:   ${status ? `DIRTY — ${status.split('\n').length} file(s) uncommitted` : 'clean'}`);
if (ahead) {
  const count = ahead.split('\n').length;
  console.log(`  ahead:  ${count} unpushed commit(s)`);
}

// ── Exit ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(
    `\n  ${failed.length}/${results.length} step(s) failed — NOT ready to promote. Fix the above, then re-run.`,
  );
  process.exit(1);
}
console.log('\n  All checks green. Ready to run `npm run promote`.');
