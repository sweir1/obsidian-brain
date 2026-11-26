import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveDataConfig } from '../src/config.js';

/**
 * Guards test/setup/isolate-data-dir.ts. If this fails, the test suite (and
 * any server it spawns) can open the developer's real kg.db again.
 */
describe('test isolation', () => {
  it('resolves the data directory to a throwaway temp dir, never the real one', () => {
    const { dataDir, dbPath } = resolveDataConfig();
    const tmp = realpathSync(tmpdir());
    expect(realpathSync(join(dataDir, '..'))).toContain(tmp);
    expect(dbPath).not.toContain(join(homedir(), '.local', 'share', 'obsidian-brain'));
  });

  it('exports the temp dirs so spawned child processes inherit them', () => {
    expect(process.env.DATA_DIR).toContain('ob-test-data-');
    expect(process.env.XDG_DATA_HOME).toContain('ob-test-data-');
  });
});
