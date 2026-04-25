import { homedir } from 'os';
import { join } from 'path';
import { UserError } from './errors.js';

export interface Config {
  vaultPath: string;
  dataDir: string;
  dbPath: string;
}

export interface ConfigOverrides {
  vaultPath?: string;
  dataDir?: string;
}

/**
 * Resolve just the data-dir + db-path without requiring a vault path.
 *
 * Used by CLI subcommands that need to read/write the local SQLite DB but
 * don't touch vault content (`models refresh-cache`, future maintenance
 * commands). The full `resolveConfig()` requires a vault path because
 * indexing/server/search all need it; pulling the DB-only path out lets
 * read-only metadata commands work without forcing the user to set
 * `VAULT_PATH` on every `npx obsidian-brain models …` invocation.
 */
export function resolveDataConfig(overrides: { dataDir?: string } = {}): { dataDir: string; dbPath: string } {
  const xdgData = process.env.XDG_DATA_HOME
    ?? join(homedir(), '.local', 'share');
  const dataDir = overrides.dataDir
    ?? process.env.DATA_DIR
    ?? process.env.KG_DATA_DIR
    ?? join(xdgData, 'obsidian-brain');
  return { dataDir, dbPath: join(dataDir, 'kg.db') };
}

export function resolveConfig(overrides: ConfigOverrides): Config {
  // VAULT_PATH is the documented name; KG_VAULT_PATH is the legacy alias
  // carried over from obra so existing users don't break.
  const vaultPath = overrides.vaultPath
    ?? process.env.VAULT_PATH
    ?? process.env.KG_VAULT_PATH;

  if (!vaultPath) {
    throw new UserError(
      'VAULT_PATH is not set. Tell obsidian-brain where your Obsidian vault lives.',
      {
        hint:
          'Examples: `VAULT_PATH=/path/to/vault obsidian-brain index` ' +
          '(macOS/Linux) or set it in the MCP client config that spawns ' +
          'this server. Legacy alias: KG_VAULT_PATH.',
      },
    );
  }

  const xdgData = process.env.XDG_DATA_HOME
    ?? join(homedir(), '.local', 'share');

  // Same alias treatment for the data dir.
  const dataDir = overrides.dataDir
    ?? process.env.DATA_DIR
    ?? process.env.KG_DATA_DIR
    ?? join(xdgData, 'obsidian-brain');

  return {
    vaultPath,
    dataDir,
    dbPath: join(dataDir, 'kg.db'),
  };
}
