import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * v1.6.10 regression: when better-sqlite3 fails to load with a Node ABI
 * mismatch (typically a stale npx cache built against a different Node
 * version), the server should surface a remediation-first error instead of
 * Node's raw `NODE_MODULE_VERSION X ... requires Y` wall of text.
 */

// Must use vi.doMock so the mock is set BEFORE the dynamic import of
// src/context in each test — vi.mock hoists too eagerly for per-test
// control.
describe('createContext() — Node ABI mismatch guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rewrites the ERR_DLOPEN_FAILED / NODE_MODULE_VERSION error with rm -rf ~/.npm/_npx', async () => {
    vi.doMock('../src/store/db.js', async (importActual) => {
      const actual: Record<string, unknown> = await importActual();
      return {
        ...actual,
        openDb: vi.fn(() => {
          const err = new Error(
            `The module '/Users/x/.npm/_npx/abc/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n` +
              `was compiled against a different Node.js version using\n` +
              `NODE_MODULE_VERSION 141. This version of Node.js requires\n` +
              `NODE_MODULE_VERSION 137.`,
          );
          throw err;
        }),
      };
    });

    // Keep the config + mkdirSync layer out of the way with a minimal env.
    const prevDataDir = process.env.DATA_DIR;
    const prevVaultPath = process.env.VAULT_PATH;
    process.env.DATA_DIR = '/tmp/obsidian-brain-abi-test';
    process.env.VAULT_PATH = '/tmp/obsidian-brain-abi-test-vault';

    try {
      const { createContext } = await import('../src/context.js');
      await expect(createContext()).rejects.toThrow(/rm -rf ~\/\.npm\/_npx/);
      await expect(createContext()).rejects.toThrow(/Node ABI mismatch/);
      await expect(createContext()).rejects.toThrow(
        new RegExp(`NODE_MODULE_VERSION=${process.versions.modules}`),
      );
    } finally {
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      if (prevVaultPath === undefined) delete process.env.VAULT_PATH;
      else process.env.VAULT_PATH = prevVaultPath;
    }
  });

  it('passes through non-ABI errors unchanged', async () => {
    vi.doMock('../src/store/db.js', async (importActual) => {
      const actual: Record<string, unknown> = await importActual();
      return {
        ...actual,
        openDb: vi.fn(() => {
          throw new Error('ENOSPC: no space left on device');
        }),
      };
    });

    const prevDataDir = process.env.DATA_DIR;
    const prevVaultPath = process.env.VAULT_PATH;
    process.env.DATA_DIR = '/tmp/obsidian-brain-abi-test-2';
    process.env.VAULT_PATH = '/tmp/obsidian-brain-abi-test-2-vault';

    try {
      const { createContext } = await import('../src/context.js');
      await expect(createContext()).rejects.toThrow(/ENOSPC/);
      await expect(createContext()).rejects.not.toThrow(/Node ABI mismatch/);
    } finally {
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      if (prevVaultPath === undefined) delete process.env.VAULT_PATH;
      else process.env.VAULT_PATH = prevVaultPath;
    }
  });
});
