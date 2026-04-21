import { readDiscovery, type DiscoveryRecord } from './discovery.js';
import { PluginUnavailableError } from './errors.js';

export interface StatusResponse {
  ok: boolean;
  pluginId: string;
  pluginVersion: string;
  vaultName: string;
  readyAt: number;
}

export interface ActiveNotePayload {
  path: string;
  basename: string;
  extension: string;
  cursor?: { line: number; ch: number };
  selection?:
    | { from: { line: number; ch: number }; to: { line: number; ch: number } }
    | null;
}

export interface ActiveResponse {
  active: ActiveNotePayload | null;
}

const DISCOVERY_CACHE_MS = 60_000;

/**
 * HTTP client for the obsidian-brain-companion Obsidian plugin. Reads the
 * discovery file at construction-time (lazily) and re-reads it when requests
 * fail with 401 (rotated token) or ECONNREFUSED (plugin restarted on a new
 * port). Throws PluginUnavailableError with a user-facing message when the
 * plugin is absent or unreachable.
 */
export class ObsidianClient {
  private cache: DiscoveryRecord | null = null;
  private cachedAt = 0;

  constructor(private readonly vaultPath: string) {}

  async status(): Promise<StatusResponse> {
    return this.request<StatusResponse>('GET', '/status');
  }

  async active(): Promise<ActiveResponse> {
    return this.request<ActiveResponse>('GET', '/active');
  }

  private async getDiscovery(forceReload = false): Promise<DiscoveryRecord> {
    const now = Date.now();
    if (
      !forceReload &&
      this.cache !== null &&
      now - this.cachedAt < DISCOVERY_CACHE_MS
    ) {
      return this.cache;
    }
    const loaded = await readDiscovery(this.vaultPath);
    if (!loaded) {
      this.cache = null;
      throw new PluginUnavailableError(
        'discovery file not found — plugin likely not installed or Obsidian is not running',
      );
    }
    this.cache = loaded;
    this.cachedAt = now;
    return loaded;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const disc = await this.getDiscovery(retried);
    const url = `http://127.0.0.1:${disc.port}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${disc.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (!retried) {
        return this.request<T>(method, path, body, true);
      }
      throw new PluginUnavailableError(
        `HTTP request to 127.0.0.1:${disc.port}${path} failed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    if (res.status === 401 && !retried) {
      return this.request<T>(method, path, body, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PluginUnavailableError(
        `plugin returned ${res.status} for ${path}: ${text.slice(0, 200)}`,
      );
    }

    return (await res.json()) as T;
  }
}
