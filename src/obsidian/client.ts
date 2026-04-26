import { readDiscovery, type DiscoveryRecord } from './discovery.js';
import { PluginUnavailableError } from './errors.js';
import { errorMessage } from '../util/errors.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/obsidian/client.ts');

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

/**
 * Normalized Dataview result wire shape (matches the plugin's
 * `src/dataview/normalize.ts`). Discriminated on `kind`.
 */
export type DataviewValue =
  | string
  | number
  | boolean
  | null
  | DataviewValue[]
  | { [k: string]: DataviewValue };

export interface DataviewListItem {
  task: boolean;
  text: string;
  path: string;
  line: number;
  section?: string;
  blockId?: string;
  tags: string[];
  annotated?: boolean;
  children: DataviewListItem[];
  status?: string;
  checked?: boolean;
  completed?: boolean;
  fullyCompleted?: boolean;
  due?: string | null;
  completion?: string | null;
  scheduled?: string | null;
  start?: string | null;
  created?: string | null;
}

export interface DataviewEvent {
  date: string | null;
  link: string;
  value?: DataviewValue[];
}

export type DataviewResult =
  | { kind: 'table'; headers: string[]; rows: DataviewValue[][] }
  | { kind: 'list'; values: DataviewValue[] }
  | { kind: 'task'; items: DataviewListItem[] }
  | { kind: 'calendar'; events: DataviewEvent[] };

/**
 * Arguments accepted by the plugin's POST /base endpoint. Either `file`
 * (vault-relative path to a `.base` YAML file) or `yaml` (inline source) is
 * required — both may be sent but the plugin prefers `file` when present.
 */
export interface BaseRequest {
  file?: string;
  yaml?: string;
  view: string;
}

/**
 * Row shape returned by the plugin's POST /base endpoint. The `file` field is
 * always populated with at minimum `{name, path}`; other columns are pulled
 * from the view's `columns:` list, flattened to primitives on the plugin side.
 */
export interface BaseRow {
  file: { name: string; path: string; [k: string]: unknown };
  [column: string]: unknown;
}

export interface BaseResult {
  view: string;
  rows: BaseRow[];
  total: number;
  executedAt: string;
}

const DISCOVERY_CACHE_MS = 60_000;
const DATAVIEW_DEFAULT_TIMEOUT_MS = 30_000;
const BASE_DEFAULT_TIMEOUT_MS = 30_000;

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

  /**
   * Returns true if the plugin advertises the given capability in its
   * discovery file. Used by capability-gated tools (e.g. dataview_query)
   * to fail fast with an upgrade prompt before the HTTP call.
   *
   * Throws PluginUnavailableError if the plugin is not reachable at all.
   */
  async has(capability: string): Promise<boolean> {
    const disc = await this.getDiscovery();
    return disc.capabilities.includes(capability);
  }

  /**
   * Runs a Dataview DQL query against the vault via the companion plugin.
   * Returns the plugin's normalized `{ kind, ... }` shape.
   *
   * `timeoutMs` aborts the HTTP wait only — the Dataview query itself has no
   * cancellation API, so on timeout the query keeps running inside Obsidian
   * to completion. Prefer `LIMIT N` in DQL for open-ended queries.
   */
  async dataview(
    query: string,
    source?: string,
    timeoutMs: number = DATAVIEW_DEFAULT_TIMEOUT_MS,
  ): Promise<DataviewResult> {
    if (!(await this.has('dataview'))) {
      const disc = await this.getDiscovery();
      throw new PluginUnavailableError(
        `dataview_query requires the companion plugin v0.2.0 or later. ` +
          `Your installed plugin version is ${disc.pluginVersion}. Upgrade via ` +
          `BRAT or the manual install step in docs/plugin.md`,
      );
    }
    return this.request<DataviewResult>(
      'POST',
      '/dataview',
      { query, source },
      false,
      { timeoutMs, kind: 'dataview' },
    );
  }

  /**
   * Evaluates an Obsidian Bases `.base` YAML file against the vault via the
   * companion plugin. The plugin runs a Path B evaluator (own YAML parser +
   * whitelisted expression subset) because Obsidian 1.12.x does not expose
   * a public read-access API for Bases (only a view-factory hook via
   * `Plugin.registerBasesView()`). See `docs/plugin.md` for the supported
   * subset; arithmetic, formulas, summaries, regex, method calls other than
   * `file.hasTag`/`file.inFolder`, and function calls all surface as
   * `unsupported_construct` errors and ship in subsequent v1.4.x patches.
   */
  async base(
    args: BaseRequest,
    opts: { timeoutMs?: number } = {},
  ): Promise<BaseResult> {
    const timeoutMs = opts.timeoutMs ?? BASE_DEFAULT_TIMEOUT_MS;
    if (!(await this.has('base'))) {
      const disc = await this.getDiscovery();
      throw new PluginUnavailableError(
        `base_query requires the companion plugin v1.4.0 or later. ` +
          `Your installed plugin version is ${disc.pluginVersion}. Upgrade via ` +
          `BRAT or the manual install step in docs/plugin.md`,
      );
    }
    return this.request<BaseResult>('POST', '/base', args, false, {
      timeoutMs,
      kind: 'base',
    });
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
    opts?: { timeoutMs?: number; kind?: 'dataview' | 'base' | 'default' },
  ): Promise<T> {
    const disc = await this.getDiscovery(retried);
    const url = `http://127.0.0.1:${disc.port}${path}`;

    const timeoutMs = opts?.timeoutMs;
    const controller = timeoutMs !== undefined ? new AbortController() : undefined;
    const timer =
      controller !== undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${disc.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (controller?.signal.aborted) {
        if (opts?.kind === 'dataview') {
          throw new Error(
            `Dataview query exceeded timeoutMs=${timeoutMs}. The query is still running inside Obsidian (Dataview has no cancellation API). Add LIMIT to your DQL or raise timeoutMs.`,
          );
        }
        if (opts?.kind === 'base') {
          throw new Error(
            `Bases evaluation exceeded timeoutMs=${timeoutMs}. The evaluator is still running inside Obsidian (no cancellation API). Add a 'limit:' to the view or raise timeoutMs.`,
          );
        }
        throw new Error(`request to ${path} exceeded timeoutMs=${timeoutMs}`);
      }
      if (!retried) {
        return this.request<T>(method, path, body, true, opts);
      }
      throw new PluginUnavailableError(
        `HTTP request to 127.0.0.1:${disc.port}${path} failed (${errorMessage(err)})`,
      );
    }
    if (timer) clearTimeout(timer);

    if (res.status === 401 && !retried) {
      return this.request<T>(method, path, body, true, opts);
    }

    if (res.status === 424) {
      const parsed = await res.json().catch(() => ({}) as { message?: string });
      throw new PluginUnavailableError(
        (parsed as { message?: string }).message ??
          `plugin returned 424 for ${path}`,
      );
    }

    if (res.status === 400) {
      const parsed = (await res
        .json()
        .catch(() => ({}))) as { error?: string; message?: string };
      const label = parsed.error ?? 'bad_request';
      throw new Error(`${label}: ${parsed.message ?? 'invalid request'}`);
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
