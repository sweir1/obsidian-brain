/**
 * Keep every test — and every process a test spawns — away from the
 * developer's real obsidian-brain files.
 *
 * The server resolves its data directory from DATA_DIR, then XDG_DATA_HOME,
 * then ~/.local/share/obsidian-brain. A test that spawned `dist/cli/index.js
 * server` without its own DATA_DIR used to open the real kg.db and reset it
 * for the test's stub embedder, discarding every vector (issue #46).
 *
 * Children inherit process.env, so pointing these variables at a throwaway
 * directory here makes that impossible even for a test that forgets to pass
 * DATA_DIR. HOME / USERPROFILE are redirected too, so the last-resort
 * fallbacks (~/.local/share, ~/.config/obsidian-brain for model overrides,
 * ~/.cache/obsidian-brain for crash logs) also land in the temp tree. This
 * overrides any DATA_DIR the developer may have exported in their shell.
 *
 * Tests that exercise the default-path logic (test/config.test.ts) delete
 * DATA_DIR / XDG_DATA_HOME themselves; with HOME redirected, even those
 * resolve inside the temp tree. test/test-isolation.test.ts guards all of
 * this, including a real child process.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ob-test-data-'));
const home = join(root, 'home');
mkdirSync(home, { recursive: true });

process.env.OB_TEST_ISOLATION_ROOT = root;
process.env.DATA_DIR = join(root, 'data');
process.env.XDG_DATA_HOME = join(root, 'xdg');
process.env.XDG_CONFIG_HOME = join(root, 'xdg-config');
process.env.XDG_CACHE_HOME = join(root, 'xdg-cache');
process.env.HOME = home;
process.env.USERPROFILE = home;
if (process.platform === 'win32') {
  process.env.APPDATA = join(root, 'appdata');
  process.env.LOCALAPPDATA = join(root, 'localappdata');
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
