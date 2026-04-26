// Regression test for the v1.7.13-diagnosed silent-crash class fixed in
// v1.7.14: when invoked via a symlink (npx .bin shim, pnpm bin, yarn-link),
// `process.argv[1]` is the symlink path while `fileURLToPath(import.meta.url)`
// is the resolved real path. Pre-v1.7.14 the strict-equality check at the
// bottom of cli/index.ts skipped the parseAsync block, the event loop drained,
// the process exited 0 cleanly, Claude Desktop reported "transport closed
// unexpectedly". The fix realpaths both sides before comparing.
//
// This test would have caught the original bug if it had existed in v1.7.5.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const distCli = resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('cli/index.ts main-entry guard', () => {
  it('runs the CLI when invoked directly via node dist/cli/index.js', () => {
    const out = execFileSync('node', [distCli, '--version'], {
      encoding: 'utf8',
    }).trim();
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs the CLI when invoked through a symlink (npx .bin shim path)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ob-symlink-test-'));
    const link = join(tmp, 'obsidian-brain-shim');
    symlinkSync(distCli, link);
    try {
      const out = execFileSync('node', [link, '--version'], {
        encoding: 'utf8',
      }).trim();
      expect(out).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
