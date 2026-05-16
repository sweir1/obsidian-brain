/**
 * v1.7.23 regression test for the prefetch.ts native-TS-loader constraint.
 *
 * Context: `scripts/prefetch-test-models.mjs` is invoked as `node scripts/...`
 * (not `tsx scripts/...`) in CI's prefetch warm-up step. Node 24's native ESM
 * + TS strip-only loader strips type annotations from prefetch.ts at load
 * time, but refuses to rewrite `.js` → `.ts` extensions in import specifiers
 * — a behaviour that diverges from vitest's Vite loader and from tsx. As a
 * result, any internal import of the form `from '../util/logger.js'` (or any
 * other `.js`-extensioned src-relative path) inside prefetch.ts breaks CI
 * with `ERR_MODULE_NOT_FOUND` while passing every local check.
 *
 * This test spawns `node scripts/prefetch-test-models.mjs --dry-run`, which
 * imports prefetch.ts via the native loader and exits before downloading
 * any models. If the constraint is violated, exit code is non-zero and
 * stderr contains `ERR_MODULE_NOT_FOUND`.
 *
 * Why a spawned subprocess (not `await import` in-test): vitest uses Vite's
 * loader, which DOES rewrite `.js` → `.ts`. Importing prefetch.ts via Vite
 * would never reproduce the failure. We must shell out to `node` so the
 * native loader is exercised exactly the way CI does it.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('prefetch.ts — Node native-loader constraint (v1.7.23 regression)', () => {
  it("imports cleanly under `node scripts/prefetch-test-models.mjs --dry-run` (no ERR_MODULE_NOT_FOUND)", () => {
    const scriptPath = resolve(process.cwd(), 'scripts/prefetch-test-models.mjs');
    const result = spawnSync('node', [scriptPath, '--dry-run'], {
      encoding: 'utf8',
      // Don't inherit TRANSFORMERS_CACHE so the dry-run can't fall into any
      // cache-touching code path. The exit-before-download guard runs first
      // anyway, but belt + braces.
      env: { ...process.env, TRANSFORMERS_CACHE: '' },
      timeout: 30_000,
    });

    // Surface the actual error message in the assertion failure so debugging
    // a regression doesn't require re-running locally.
    const debugContext = `exit=${result.status} signal=${result.signal}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`;

    expect(result.status, debugContext).toBe(0);
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.stdout).toMatch(/dry-run.*imported cleanly via Node native loader/);
  }, 35_000);
});
