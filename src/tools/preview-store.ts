/**
 * In-memory preview cache for `edit_note` dry-run previews.
 *
 * Design notes:
 *   - TTL: 5 minutes. Previews that have not been applied within 5 minutes are
 *     silently evicted on the next `set()` or `get()` call. If a preview
 *     expires the agent must re-run `edit_note` with `dryRun: true`.
 *   - Cap: 50 entries. When the store is full, the oldest entry (by `createdAt`)
 *     is evicted to make room for the new one.
 *   - stdio MCP is one-process-per-client (per modelcontextprotocol.io/docs/learn/architecture).
 *     Process-global state is therefore equivalent to per-session state — no
 *     session-id partitioning is needed.
 */

export interface PendingEdit {
  previewId: string;
  path: string;             // vault-relative path
  originalContent: string;
  proposedContent: string;
  diff: string;             // unified-diff string (from `diff` package `createPatch`)
  mode: string;             // edit mode name (e.g. 'append', 'replace_window')
  createdAt: number;        // Date.now() at the time the preview was created
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PREVIEWS = 50;

export class PreviewStore {
  private store = new Map<string, PendingEdit>();

  set(preview: PendingEdit): void {
    this.evictExpired();
    if (this.store.size >= MAX_PREVIEWS) {
      // Evict oldest entry by createdAt timestamp.
      const oldest = [...this.store.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      if (oldest) this.store.delete(oldest[0]);
    }
    this.store.set(preview.previewId, preview);
  }

  get(previewId: string): PendingEdit | undefined {
    this.evictExpired();
    return this.store.get(previewId);
  }

  delete(previewId: string): boolean {
    return this.store.delete(previewId);
  }

  /** Exposed for tests — returns current store size (after eviction). */
  get size(): number {
    this.evictExpired();
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, p] of this.store) {
      if (now - p.createdAt > TTL_MS) this.store.delete(id);
    }
  }
}

/** Process-global singleton. Safe because stdio MCP is single-client per process. */
export const previewStore = new PreviewStore();
