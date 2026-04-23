#!/usr/bin/env node
/**
 * preflight.mjs — single-command readiness check before `npm run promote`.
 *
 * Runs, in order:
 *   1. gen-docs --check         (docs/configuration.md in sync with config.ts)
 *   2. gen-tools-docs --check   (docs/tools.md in sync with Zod schemas)
 *   3. check-plugin             (plugin manifest major.minor matches)
 *   4. build                    (tsc — type-check + emit dist/)
 *   5. test                     (vitest run — full suite)
 *   6. smoke                    (scripts/mcp-smoke.ts — end-to-end MCP client
 *                                against the compiled binary)
 *
 * Each step streams its output live. At the end, prints a pass/fail summary
 * with timings + a git-state footer. Exits 1 if any step failed.
 *
 * This is informational — it does not commit, push, bump, or publish. Run
 * `npm run promote` explicitly once preflight is green.
 */
import { spawnSync, execSync } from 'node:child_process';

const STEPS = [
  { name: 'gen-docs (check)',       cmd: 'npm', args: ['run', 'gen-docs', '--', '--check'] },
  { name: 'gen-tools-docs (check)', cmd: 'npm', args: ['run', 'gen-tools-docs', '--', '--check'] },
  { name: 'check-plugin',           cmd: 'npm', args: ['run', 'check-plugin'] },
  { name: 'build (tsc)',            cmd: 'npm', args: ['run', 'build'] },
  { name: 'tests (vitest)',         cmd: 'npm', args: ['test'] },
  { name: 'smoke (MCP client)',     cmd: 'npm', args: ['run', 'smoke'] },
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

const results = [];
for (const step of STEPS) {
  process.stdout.write(`\n${BAR}\n▶ ${step.name}\n${BAR}\n`);
  const t0 = Date.now();
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit' });
  const ms = Date.now() - t0;
  results.push({ name: step.name, ok: r.status === 0, ms });
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${BAR}\n  PREFLIGHT SUMMARY\n${BAR}`);
for (const r of results) {
  const mark = r.ok ? '✓' : '✗';
  console.log(`  ${mark}  ${r.name.padEnd(24)}  ${fmt(r.ms)}`);
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
