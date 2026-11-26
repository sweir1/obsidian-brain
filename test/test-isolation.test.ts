import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig, resolveDataConfig } from '../src/config.js';
import { getUserConfigDir } from '../src/embeddings/user-config.js';

/**
 * Guards test/setup/isolate-data-dir.ts (issue #46). If any of these fail,
 * the test suite — or a server process it spawns — can open the developer's
 * real kg.db again and wipe its vectors.
 */

const root = process.env.OB_TEST_ISOLATION_ROOT ?? '';
// The account's real home from the password database. Unlike os.homedir(),
// this ignores the HOME override, so it is what a leaky child would hit.
const realHome = userInfo().homedir;
const realDataDir = join(realHome, '.local', 'share', 'obsidian-brain');

/** True only when the setup ran and `p` is strictly inside its temp root. */
function underRoot(p: string): boolean {
  return root !== '' && p.startsWith(root + sep);
}

function inside(dir: string, parent: string): boolean {
  const rel = relative(realpathSync(parent), realpathSync(dir));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

// This file quotes leaky envs in comments and fixtures; skip it.
const SELF = fileURLToPath(import.meta.url);

/** Test files that spawn a process with an env not built from process.env. */
function findLeakyEnvs(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && p !== SELF) check(p);
    }
  };
  const check = (file: string): void => {
    const src = readFileSync(file, 'utf8');
    if (!/\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/.test(src)) return;
    const rel = relative(dir, file);
    // Inline env objects must spread process.env.
    for (const m of src.matchAll(/\benv:\s*\{([^}]*)\}/g)) {
      if (!m[1].includes('...process.env')) offenders.push(`${rel}: env: {${m[1].trim().slice(0, 60)}}`);
    }
    // A named env object (`env,` or `env: childEnv`) must be built from it.
    if (/\benv(:\s*[A-Za-z_$][\w$]*)?\s*[,}]/.test(src) && !src.includes('...process.env')) {
      offenders.push(`${rel}: env variable not built from process.env`);
    }
  };
  walk(dir);
  return offenders;
}

describe('test isolation (issue #46)', () => {
  it('setup created an isolation root under the OS temp dir', () => {
    expect(root).toContain('ob-test-data-');
    expect(inside(root, tmpdir())).toBe(true);
  });

  it('exports the temp dirs so spawned child processes inherit them', () => {
    for (const name of ['DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'HOME']) {
      expect(process.env[name], name).toContain('ob-test-data-');
    }
  });

  it('resolves the data directory inside the temp root, never the real one', () => {
    const { dataDir, dbPath } = resolveDataConfig();
    expect(underRoot(dataDir)).toBe(true);
    expect(dbPath.startsWith(realDataDir)).toBe(false);
  });

  it('even the no-env-var fallback (~/.local/share) lands in the temp root', () => {
    const saved = { DATA_DIR: process.env.DATA_DIR, KG_DATA_DIR: process.env.KG_DATA_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    try {
      delete process.env.DATA_DIR;
      delete process.env.KG_DATA_DIR;
      delete process.env.XDG_DATA_HOME;
      const { dbPath } = resolveConfig({ vaultPath: '/tmp/vault' });
      expect(underRoot(dbPath)).toBe(true);
      expect(dbPath.startsWith(realDataDir)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('redirects home, so the user config and crash-log dirs are throwaway too', () => {
    expect(underRoot(homedir())).toBe(true);
    expect(underRoot(getUserConfigDir())).toBe(true);
  });

  it('a real CLI child process with an inherited env writes kg.db inside the temp root', () => {
    // Reproduces #46: the shutdown test spawned the server with
    // `{ ...process.env, VAULT_PATH }` and no DATA_DIR of its own. `health`
    // goes through the same createContext() → openDb() path as `server`,
    // creating kg.db at the resolved location, and exits in well under a
    // second.
    const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
    expect(existsSync(cli), 'dist/cli/index.js missing — run `npm run build`').toBe(true);

    const vault = mkdtempSync(join(tmpdir(), 'ob-isolation-vault-'));
    writeFileSync(join(vault, 'a.md'), '# a\n');
    const realDbBefore = existsSync(join(realDataDir, 'kg.db')) ? statSync(join(realDataDir, 'kg.db')).ino : null;
    try {
      const res = spawnSync(process.execPath, [cli, 'health'], {
        env: {
          ...process.env,
          VAULT_PATH: vault,
          EMBEDDING_PROVIDER: 'ollama',
          OLLAMA_BASE_URL: 'http://127.0.0.1:1',
          OLLAMA_EMBEDDING_DIM: '384',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(join(process.env.DATA_DIR!, 'kg.db'))).toBe(true);
      // The real index (if this machine has one) is the same file it was.
      const realDbAfter = existsSync(join(realDataDir, 'kg.db')) ? statSync(join(realDataDir, 'kg.db')).ino : null;
      expect(realDbAfter).toBe(realDbBefore);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('every test that spawns a process with a custom env keeps the isolation vars', () => {
    // A child given `env: { PATH, VAULT_PATH }` (no `...process.env`) loses
    // DATA_DIR *and* HOME, and os.homedir() then falls back to the real home
    // from the password database. Each custom env must start from
    // process.env (overriding vars on top is fine).
    expect(findLeakyEnvs(join(process.cwd(), 'test'))).toEqual([]);
  });

  it('the guard above catches a leaky env (negative control)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ob-isolation-guard-'));
    try {
      writeFileSync(join(dir, 'leaky.test.ts'), "spawn(node, [cli, 'server'], { env: { PATH: process.env.PATH } });\n");
      writeFileSync(join(dir, 'named.test.ts'), "const env = { PATH: '/bin' };\nspawnSync(node, [cli], { env, encoding: 'utf8' });\n");
      writeFileSync(join(dir, 'ok.test.ts'), "spawn(node, [cli], { env: { ...process.env, VAULT_PATH: v } });\n");
      expect(findLeakyEnvs(dir).map((o) => o.split(':')[0]).sort()).toEqual(['leaky.test.ts', 'named.test.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
