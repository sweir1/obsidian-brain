/**
 * Keep every test — and every server process a test spawns — away from the
 * developer's real index.
 *
 * The server resolves its data directory from DATA_DIR, then XDG_DATA_HOME,
 * then ~/.local/share/obsidian-brain. A test that spawned `dist/cli/index.js
 * server` without its own DATA_DIR used to open the real kg.db and reset it
 * for the test's stub embedder, discarding every vector. Children inherit
 * process.env, so pointing both variables at a throwaway directory here
 * makes that impossible even for a test that forgets to pass DATA_DIR. It
 * also overrides a DATA_DIR the developer may have exported in their shell.
 *
 * Tests that exercise the default-path logic (test/config.test.ts) delete
 * these variables themselves, so they are unaffected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ob-test-data-'));
process.env.DATA_DIR = join(root, 'data');
process.env.XDG_DATA_HOME = join(root, 'xdg');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
