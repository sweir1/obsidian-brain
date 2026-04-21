import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Shape of the discovery file written by the obsidian-brain-companion plugin
 * at `{VAULT}/.obsidian/plugins/obsidian-brain-companion/discovery.json`.
 */
export interface DiscoveryRecord {
  port: number;
  token: string;
  pid: number;
  pluginVersion: string;
  startedAt: number;
}

export function discoveryFilePath(vaultPath: string): string {
  return join(
    vaultPath,
    '.obsidian',
    'plugins',
    'obsidian-brain-companion',
    'discovery.json',
  );
}

/**
 * Load and validate the discovery file. Returns `null` when the file is
 * missing, unreadable, or malformed — callers treat all of these the same
 * way ("plugin not available").
 */
export async function readDiscovery(
  vaultPath: string,
): Promise<DiscoveryRecord | null> {
  try {
    const raw = await readFile(discoveryFilePath(vaultPath), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DiscoveryRecord>;
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pluginVersion === 'string'
    ) {
      return {
        port: parsed.port,
        token: parsed.token,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        pluginVersion: parsed.pluginVersion,
        startedAt:
          typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}
